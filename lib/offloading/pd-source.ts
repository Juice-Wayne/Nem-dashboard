/**
 * Provider for "expected gen" PD targets per LYB unit per 5-min interval.
 *
 * Strategy:
 *   Past intervals    → AEMO Next_Day_Dispatch (DISPATCH_UNIT_SOLUTION.TOTALCLEARED, 5-min)
 *   Forward intervals → AEMO Next_Day_PreDispatch (PREDISPATCH_UNIT_SOLUTION.TOTALCLEARED, 30-min)
 *                        forward-filled to 5-min (each 5-min interval inherits the next 30-min boundary's value)
 *
 * Forward PD only resolves once today's Next_Day_PreDispatch publishes (~12:30
 * the prior afternoon for tomorrow). Same-day intervals before that publish
 * still return null.
 */

import { fetchArchiveDay } from "@/lib/nemweb/fetcher";
import type { PDByInterval } from "./math";

const DISPATCH_TABLE = "DISPATCH_UNIT_SOLUTION";
const PREDISPATCH_TABLE = "PREDISPATCH_UNIT_SOLUTION";
const TARGET_FIELD = "TOTALCLEARED";

/** Convert an ISO timestamp to its AEST (UTC+10, no DST) calendar date. */
function isoToAestDate(iso: string): string {
  const aest = new Date(new Date(iso).getTime() + 10 * 60 * 60 * 1000);
  return aest.toISOString().slice(0, 10);
}

function todayAestDate(): string {
  return isoToAestDate(new Date().toISOString());
}

function aemoToIsoUTC(aemo: string): string {
  const [d, t] = aemo.split(" ");
  return new Date(d.replace(/\//g, "-") + "T" + t + "+10:00").toISOString();
}

/** Snap a 5-min interval-ending ISO up to the next 30-min boundary. */
function ceilTo30MinISO(iso: string): string {
  const ms = new Date(iso).getTime();
  const thirtyMin = 30 * 60 * 1000;
  return new Date(Math.ceil(ms / thirtyMin) * thirtyMin).toISOString();
}

/**
 * Fetch PD targets for the given intervals.
 * intervals are 5-min interval-ending ISO timestamps (UTC).
 */
export async function getPDTargets(intervals: string[]): Promise<PDByInterval> {
  const result: PDByInterval = new Map();
  for (const iv of intervals) result.set(iv, { lyb1: null, lyb2: null });
  if (intervals.length === 0) return result;

  const today = todayAestDate();
  const wanted = new Set(intervals);

  // Past intervals — Next_Day_Dispatch (5-min cleared targets, definitive).
  const pastDates = new Set<string>();
  // Forward intervals — Next_Day_PreDispatch (30-min targets, forward-fill).
  const forwardDates = new Set<string>();
  for (const iv of intervals) {
    const d = isoToAestDate(iv);
    if (d < today) pastDates.add(d);
    else forwardDates.add(d);
  }

  // Past: fetch in parallel, populate exact 5-min matches.
  if (pastDates.size > 0) {
    const fetches = await Promise.allSettled(
      Array.from(pastDates).map((date) =>
        fetchArchiveDay("NEXT_DAY_DISPATCH", date, new Set([DISPATCH_TABLE])),
      ),
    );
    for (const r of fetches) {
      if (r.status === "rejected") {
        console.warn(
          "[pd-source] Next_Day_Dispatch fetch failed:",
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
        continue;
      }
      const rows = r.value.get(DISPATCH_TABLE) ?? [];
      for (const row of rows) {
        const duid = row.DUID;
        if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
        const iso = aemoToIsoUTC(row.SETTLEMENTDATE);
        if (!wanted.has(iso)) continue;
        const mw = Number(row[TARGET_FIELD]);
        if (!Number.isFinite(mw)) continue;
        const bucket = result.get(iso)!;
        if (duid === "LOYYB1") bucket.lyb1 = mw;
        else bucket.lyb2 = mw;
      }
    }
  }

  // Forward: fetch Next_Day_PreDispatch published for *yesterday* (covers the next ~36hrs from
  // the run, including today and tomorrow). Use yesterday's file as primary; today's not yet
  // published until ~12:30 PM AEST.
  if (forwardDates.size > 0) {
    const yesterday = isoToYesterday(today);
    const candidateDates = [today, yesterday];
    const forwardPD = new Map<string, { lyb1: number | null; lyb2: number | null }>();

    // Track latest PREDISPATCHSEQNO per (DUID, DATETIME) — file contains many runs.
    const latestSeqno = new Map<string, string>(); // key = DUID|DATETIME

    for (const date of candidateDates) {
      try {
        const tables = await fetchArchiveDay(
          "NEXT_DAY_PREDISPATCH",
          date,
          new Set([PREDISPATCH_TABLE]),
          (table, row) => {
            // Drop everything except LYB1/LYB2 unit-solution rows at parse time
            // (file contains ~330 DUIDs × 48 periods × ~94 runs = ~1.5M rows otherwise).
            if (table !== PREDISPATCH_TABLE) return false;
            return row.DUID === "LOYYB1" || row.DUID === "LOYYB2";
          },
        );
        const rows = tables.get(PREDISPATCH_TABLE) ?? [];
        for (const row of rows) {
          const duid = row.DUID;
          const dt = row.DATETIME;
          const seqno = row.PREDISPATCHSEQNO;
          if (!dt || !seqno) continue;
          const iso = aemoToIsoUTC(dt);
          const key = `${duid}|${iso}`;
          const prevSeq = latestSeqno.get(key);
          if (prevSeq != null && prevSeq >= seqno) continue;
          const mw = Number(row[TARGET_FIELD]);
          if (!Number.isFinite(mw)) continue;
          latestSeqno.set(key, seqno);
          const bucket = forwardPD.get(iso) ?? { lyb1: null, lyb2: null };
          if (duid === "LOYYB1") bucket.lyb1 = mw;
          else bucket.lyb2 = mw;
          forwardPD.set(iso, bucket);
        }
        if (forwardPD.size > 0) break;
      } catch (e) {
        console.warn(
          `[pd-source] Next_Day_PreDispatch fetch failed for ${date}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    // Forward-fill: each 5-min interval inherits the next 30-min boundary's value.
    for (const iv of intervals) {
      const slot = result.get(iv)!;
      if (slot.lyb1 != null && slot.lyb2 != null) continue; // already filled by past data
      const bucket30 = forwardPD.get(ceilTo30MinISO(iv));
      if (!bucket30) continue;
      if (slot.lyb1 == null && bucket30.lyb1 != null) slot.lyb1 = bucket30.lyb1;
      if (slot.lyb2 == null && bucket30.lyb2 != null) slot.lyb2 = bucket30.lyb2;
    }
  }

  return result;
}

function isoToYesterday(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
