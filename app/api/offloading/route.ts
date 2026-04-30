import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay, fetchLatest, SOURCES } from "@/lib/nemweb";

const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  intervalEnding: string;
  scadaLyb1: number | null;
  scadaLyb2: number | null;
}

const INTERVAL_MIN = 5;

// All ISO timestamps in this module use the AEMO "wall-clock-as-Z" convention:
// AEMO stamps SETTLEMENTDATE in AEST without a tz, and aemoToIso() just appends Z
// — so 14:00 AEST → "...T14:00:00.000Z". For comparisons against AEMO data these
// helpers must produce the same convention rather than real UTC.

const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

function isoToAemoDate(iso: string): string {
  return iso.slice(0, 10);
}

function todayIso(): string {
  // Today's date in AEST.
  return new Date(Date.now() + AEST_OFFSET_MS).toISOString().slice(0, 10);
}

function nowIso(): string {
  // Current AEST wall-clock as a Z-suffixed ISO string (matches request strings).
  return new Date(Date.now() + AEST_OFFSET_MS).toISOString();
}

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

function aemoToIso(aemo: string): string {
  return new Date(aemo.replace(/\//g, "-").replace(" ", "T") + "Z").toISOString();
}

/**
 * Fetch SCADA for any past intervals (date < today, plus today-up-to-now).
 * Combines historical day archives with the live Dispatch_SCADA feed so today's
 * recent intervals are covered.
 */
async function fetchScada(
  intervals: string[],
): Promise<Map<string, { lyb1: number | null; lyb2: number | null }>> {
  const wanted = new Set(intervals);
  const buckets = new Map<string, { lyb1: number | null; lyb2: number | null }>();
  for (const iv of intervals) buckets.set(iv, { lyb1: null, lyb2: null });

  const now = nowIso();
  const today = todayIso();
  const archiveDates = new Set<string>();
  let earliestTodayIv: string | null = null;
  for (const iv of intervals) {
    if (iv > now) continue; // future, no SCADA
    const d = isoToAemoDate(iv);
    if (d < today) archiveDates.add(d);
    else if (d === today) {
      if (!earliestTodayIv || iv < earliestTodayIv) earliestTodayIv = iv;
    }
  }

  const archivePromise = Promise.allSettled(
    Array.from(archiveDates).map((date) =>
      fetchArchiveDay("DISPATCHSCADA", date, SCADA_TABLES).then((tables) => ({ date, tables })),
    ),
  );

  // Live feed: each file holds one 5-min interval. Pull enough files to span
  // from the earliest today-past interval up to now. AEMO publishes ~288/day.
  let liveCount = 0;
  if (earliestTodayIv) {
    const minutesBack = Math.max(0, (Date.parse(now) - Date.parse(earliestTodayIv)) / 60_000);
    liveCount = Math.min(288, Math.ceil(minutesBack / 5) + 4);
  }
  const livePromise =
    liveCount > 0
      ? fetchLatest({ ...SOURCES.dispatchScada, count: liveCount }).catch((e) => {
          console.warn("[offloading] live SCADA fetch failed:", e instanceof Error ? e.message : e);
          return [] as Map<string, Record<string, string>[]>[];
        })
      : Promise.resolve([] as Map<string, Record<string, string>[]>[]);

  const [archiveResults, liveResults] = await Promise.all([archivePromise, livePromise]);

  for (const r of archiveResults) {
    if (r.status === "rejected") {
      console.warn(
        "[offloading] SCADA archive fetch failed:",
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
      continue;
    }
    const rows = r.value.tables.get("DISPATCH_UNIT_SCADA") ?? [];
    consumeScadaRows(rows, wanted, buckets);
  }
  for (const tables of liveResults) {
    const rows = tables.get("DISPATCH_UNIT_SCADA") ?? [];
    consumeScadaRows(rows, wanted, buckets);
  }
  return buckets;
}

function consumeScadaRows(
  rows: Record<string, string>[],
  wanted: Set<string>,
  buckets: Map<string, { lyb1: number | null; lyb2: number | null }>,
) {
  for (const row of rows) {
    const duid = row.DUID;
    if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
    const iso = aemoToIso(row.SETTLEMENTDATE);
    if (!wanted.has(iso)) continue;
    const mw = Number(row.SCADAVALUE);
    if (!Number.isFinite(mw)) continue;
    const b = buckets.get(iso)!;
    if (duid === "LOYYB1") b.lyb1 = mw;
    else b.lyb2 = mw;
  }
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
    const scada = await fetchScada(intervals);

    const response: IntervalResponse[] = intervals.map((iv) => {
      const s = scada.get(iv) ?? { lyb1: null, lyb2: null };
      return {
        intervalEnding: iv,
        scadaLyb1: s.lyb1,
        scadaLyb2: s.lyb2,
      };
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
