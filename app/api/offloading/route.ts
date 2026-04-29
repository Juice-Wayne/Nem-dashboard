import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay } from "@/lib/nemweb";

const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  /** ISO timestamp for the 5-min interval ending (UTC). */
  intervalEnding: string;
  /** LYB1 MW for this 5-min interval. */
  lyb1Mw: number | null;
  /** LYB2 MW for this 5-min interval. */
  lyb2Mw: number | null;
}

const INTERVAL_MIN = 5;

function isoToAemoDate(iso: string): string {
  // "2026-04-24T13:00:00.000Z" → "2026-04-24"
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Generate 5-min interval-ending ISO timestamps covering [startISO, startISO + durationHrs). */
function enumerateIntervals(startISO: string, durationHrs: number): string[] {
  const out: string[] = [];
  const start = new Date(startISO).getTime();
  const rows = Math.round(durationHrs * (60 / INTERVAL_MIN));
  const stepMs = INTERVAL_MIN * 60 * 1000;
  for (let i = 0; i < rows; i++) {
    out.push(new Date(start + i * stepMs).toISOString());
  }
  return out;
}

/** AEMO SETTLEMENTDATE is "2026/04/24 13:05:00" — convert to ISO UTC. */
function aemoToIso(aemo: string): string {
  return new Date(aemo.replace(/\//g, "-").replace(" ", "T") + "Z").toISOString();
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const startISO = sp.get("start");
    const durationStr = sp.get("durationHrs");
    if (!startISO || !durationStr) {
      return NextResponse.json({ error: "missing start or durationHrs" }, { status: 400 });
    }
    const durationHrs = Number(durationStr);
    if (!Number.isFinite(durationHrs) || durationHrs < 1 || durationHrs > 24) {
      return NextResponse.json({ error: "durationHrs must be 1..24" }, { status: 400 });
    }

    const intervals = enumerateIntervals(startISO, durationHrs);
    const wanted = new Set(intervals);

    const today = todayIso();
    const datesNeeded = new Set<string>();
    for (const iv of intervals) {
      const d = isoToAemoDate(iv);
      if (d < today) datesNeeded.add(d);
    }

    // Map intervalEnding → { LYB1, LYB2 } MW (latest seen wins; AEMO 5-min is unique).
    const buckets = new Map<string, { LOYYB1: number | null; LOYYB2: number | null }>();
    for (const iv of intervals) buckets.set(iv, { LOYYB1: null, LOYYB2: null });

    const results = await Promise.allSettled(
      Array.from(datesNeeded).map((date) =>
        fetchArchiveDay("DISPATCHSCADA", date, SCADA_TABLES).then((tables) => ({ date, tables })),
      ),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn(
          "[offloading] SCADA fetch failed:",
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
        continue;
      }
      const rows = r.value.tables.get("DISPATCH_UNIT_SCADA") ?? [];
      for (const row of rows) {
        const duid = row.DUID;
        if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
        const intervalEndISO = aemoToIso(row.SETTLEMENTDATE);
        if (!wanted.has(intervalEndISO)) continue;
        const mw = Number(row.SCADAVALUE);
        if (!Number.isFinite(mw)) continue;
        const bucket = buckets.get(intervalEndISO)!;
        bucket[duid] = mw;
      }
    }

    const response: IntervalResponse[] = intervals.map((iv) => {
      const b = buckets.get(iv)!;
      return { intervalEnding: iv, lyb1Mw: b.LOYYB1, lyb2Mw: b.LOYYB2 };
    });

    return NextResponse.json(
      { intervals: response },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (e) {
    console.error("[offloading] API error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
