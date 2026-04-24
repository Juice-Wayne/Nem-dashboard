import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay } from "@/lib/nemweb";

const LYB_DUIDS = ["LOYYB1", "LOYYB2"] as const;
const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  /** ISO timestamp for the half-hour ending (UTC). */
  hhEnding: string;
  /** Average LYB1 MW across the six 5-min intervals in this HH. */
  lyb1Mw: number | null;
  /** Average LYB2 MW across the six 5-min intervals in this HH. */
  lyb2Mw: number | null;
}

function isoToAemoDate(iso: string): string {
  // "2026-04-24T13:00:00.000Z" → "2026-04-24"
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Generate HH-ending ISO timestamps covering [startISO, startISO + durationHrs). */
function enumerateHHs(startISO: string, durationHrs: number): string[] {
  const out: string[] = [];
  const start = new Date(startISO).getTime();
  const rows = Math.round(durationHrs * 2);
  for (let i = 0; i < rows; i++) {
    out.push(new Date(start + (i + 1) * 30 * 60 * 1000).toISOString());
  }
  return out;
}

/** AEMO SETTLEMENTDATE is "2026/04/24 13:05:00" — convert to ISO UTC. */
function aemoToIso(aemo: string): string {
  return new Date(aemo.replace(/\//g, "-").replace(" ", "T") + "Z").toISOString();
}

/** Bucket the 5-min interval ending at `ts` into its HH-ending. 13:05→13:30; 13:30→13:30; 13:35→14:00. */
function bucketHHEnding(intervalEndISO: string): string {
  const ms = new Date(intervalEndISO).getTime();
  const thirtyMin = 30 * 60 * 1000;
  return new Date(Math.ceil(ms / thirtyMin) * thirtyMin).toISOString();
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

    const hhs = enumerateHHs(startISO, durationHrs);
    // Collect unique dates we need to fetch (past only — today is not archived yet).
    const today = todayIso();
    const datesNeeded = new Set<string>();
    for (const hh of hhs) {
      const d = isoToAemoDate(hh);
      if (d < today) datesNeeded.add(d);
    }

    // Map hhEnding → { LYB1: values[], LYB2: values[] } for averaging.
    const buckets = new Map<string, { LOYYB1: number[]; LOYYB2: number[] }>();
    for (const hh of hhs) buckets.set(hh, { LOYYB1: [], LOYYB2: [] });

    for (const date of datesNeeded) {
      const tables = await fetchArchiveDay("DISPATCHSCADA", date, SCADA_TABLES);
      const rows = tables.get("DISPATCH_UNIT_SCADA") ?? [];
      for (const row of rows) {
        const duid = row.DUID;
        if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
        const intervalEndISO = aemoToIso(row.SETTLEMENTDATE);
        const hhEnd = bucketHHEnding(intervalEndISO);
        const bucket = buckets.get(hhEnd);
        if (!bucket) continue;
        const mw = Number(row.SCADAVALUE);
        if (!Number.isFinite(mw)) continue;
        bucket[duid].push(mw);
      }
    }

    const intervals: IntervalResponse[] = hhs.map((hh) => {
      const b = buckets.get(hh)!;
      const avg = (arr: number[]) => (arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : null);
      return { hhEnding: hh, lyb1Mw: avg(b.LOYYB1), lyb2Mw: avg(b.LOYYB2) };
    });

    return NextResponse.json(
      { intervals },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (e) {
    console.error("[offloading] API error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
