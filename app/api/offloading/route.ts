import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay } from "@/lib/nemweb";
import { getPDTargets } from "@/lib/offloading/pd-source";

const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  intervalEnding: string;
  scadaLyb1: number | null;
  scadaLyb2: number | null;
  pdLyb1: number | null;
  pdLyb2: number | null;
}

const INTERVAL_MIN = 5;

function isoToAemoDate(iso: string): string {
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

async function fetchScada(
  intervals: string[],
): Promise<Map<string, { lyb1: number | null; lyb2: number | null }>> {
  const wanted = new Set(intervals);
  const buckets = new Map<string, { lyb1: number | null; lyb2: number | null }>();
  for (const iv of intervals) buckets.set(iv, { lyb1: null, lyb2: null });

  const today = todayIso();
  const datesNeeded = new Set<string>();
  for (const iv of intervals) {
    const d = isoToAemoDate(iv);
    if (d < today) datesNeeded.add(d);
  }

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
      const iso = aemoToIso(row.SETTLEMENTDATE);
      if (!wanted.has(iso)) continue;
      const mw = Number(row.SCADAVALUE);
      if (!Number.isFinite(mw)) continue;
      const b = buckets.get(iso)!;
      if (duid === "LOYYB1") b.lyb1 = mw;
      else b.lyb2 = mw;
    }
  }
  return buckets;
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

    const [scada, pd] = await Promise.all([
      fetchScada(intervals),
      getPDTargets(intervals),
    ]);

    const response: IntervalResponse[] = intervals.map((iv) => {
      const s = scada.get(iv) ?? { lyb1: null, lyb2: null };
      const p = pd.get(iv) ?? { lyb1: null, lyb2: null };
      return {
        intervalEnding: iv,
        scadaLyb1: s.lyb1,
        scadaLyb2: s.lyb2,
        pdLyb1: p.lyb1,
        pdLyb2: p.lyb2,
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
