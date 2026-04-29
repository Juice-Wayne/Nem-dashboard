/**
 * Provider abstraction for "expected gen" PD targets per LYB unit per 5-min interval.
 *
 * Past intervals → AEMO Next_Day_Dispatch (DISPATCHLOAD.TOTALCLEARED).
 * Forward intervals → P5MIN / Predispatch — TODO (returns null for now; UI shows blank PD col).
 */

import { fetchArchiveDay } from "@/lib/nemweb/fetcher";
import type { PDByInterval } from "./math";

const DISPATCHLOAD_TABLE = "DISPATCH_UNIT_SOLUTION";
const TARGET_FIELD = "TOTALCLEARED";

function isoToAemoDate(iso: string): string {
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function aemoToIsoUTC(aemo: string): string {
  // AEMO publishes "YYYY/MM/DD HH:MM:SS" in NEM time (AEST, no DST).
  const [d, t] = aemo.split(" ");
  return new Date(d.replace(/\//g, "-") + "T" + t + "+10:00").toISOString();
}

/**
 * Fetch PD targets for the given intervals.
 * intervals are 5-min interval-ending ISO timestamps (UTC).
 */
export async function getPDTargets(intervals: string[]): Promise<PDByInterval> {
  const result: PDByInterval = new Map();
  for (const iv of intervals) result.set(iv, { lyb1: null, lyb2: null });

  // Group needed dates (past only — Next_Day_Dispatch publishes ~01:00 next day).
  const today = todayIso();
  const datesNeeded = new Set<string>();
  for (const iv of intervals) {
    const d = isoToAemoDate(iv);
    if (d < today) datesNeeded.add(d);
  }
  if (datesNeeded.size === 0) return result;

  const wanted = new Set(intervals);

  const fetches = await Promise.allSettled(
    Array.from(datesNeeded).map((date) =>
      fetchArchiveDay("NEXT_DAY_DISPATCH", date, new Set([DISPATCHLOAD_TABLE])).then((tables) => ({
        date,
        tables,
      })),
    ),
  );

  for (const r of fetches) {
    if (r.status === "rejected") {
      console.warn(
        "[pd-source] NEXT_DAY_DISPATCH fetch failed:",
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
      continue;
    }
    const rows = r.value.tables.get(DISPATCHLOAD_TABLE) ?? [];
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

  return result;
}
