import { fetchArchiveDay, clearArchiveCache } from "@/lib/nemweb";

// Only parse the tables we actually need — dropping the rest at CSV parse time
// shrinks per-day memory by ~90% (DispatchIS has ~15 tables we don't use).
const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);
const DISPATCH_PRICE_TABLES = new Set(["DISPATCH_PRICE"]);

// Plant definitions — DUIDs + which region to match spot prices against.
export const PLANTS = {
  braemar: { duids: ["BRAEMAR1", "BRAEMAR2", "BRAEMAR3"], region: "QLD1" },
  bdl:     { duids: ["BDL01", "BDL02"],                    region: "VIC1" },
} as const;

export type PlantKey = keyof typeof PLANTS;

const INTERVAL_HOURS = 5 / 60;

export interface DayUnitAgg {
  mwh: number;
  runIntervals: number;
  runRrpWeighted: number;
  runMwTotal: number;
  revenue: number;
}

export interface DayResult {
  date: string;                                          // YYYY-MM-DD
  units: Record<string, DayUnitAgg>;
  intervals: Array<{ t: string; rrp: number; units: Record<string, number> }>;
}

export interface MonthResult {
  plant: PlantKey;
  duids: readonly string[];
  region: string;
  month: string;                                         // YYYY-MM
  generatedAt: string;                                   // ISO timestamp
  days: DayResult[];
}

function toIsoTime(aemo: string): string {
  // "2026/01/01 00:05:00" → "2026-01-01T00:05:00"
  return aemo.replace(/\//g, "-").replace(" ", "T");
}

/** Fetch + aggregate one day for a plant. */
export async function buildRevenueDay(plant: PlantKey, isoDate: string): Promise<DayResult> {
  const { duids, region } = PLANTS[plant];

  const [scadaTables, priceTables] = await Promise.all([
    fetchArchiveDay("DISPATCHSCADA", isoDate, SCADA_TABLES),
    fetchArchiveDay("DISPATCHIS", isoDate, DISPATCH_PRICE_TABLES),
  ]);

  // RRP lookup: SETTLEMENTDATE → RRP for this plant's region, non-intervention rows
  const priceRows = priceTables.get("DISPATCH_PRICE") ?? [];
  const rrpByTime = new Map<string, number>();
  for (const row of priceRows) {
    if (row.REGIONID !== region) continue;
    if (row.INTERVENTION && row.INTERVENTION !== "0") continue;
    const t = row.SETTLEMENTDATE;
    if (!t) continue;
    rrpByTime.set(t, Number(row.RRP) || 0);
  }

  // SCADA lookup: SETTLEMENTDATE → { DUID → MW } filtered to our DUIDs
  const scadaRows = scadaTables.get("DISPATCH_UNIT_SCADA") ?? [];
  const duidSet = new Set<string>(duids);
  const scadaByTime = new Map<string, Map<string, number>>();
  for (const row of scadaRows) {
    if (!duidSet.has(row.DUID)) continue;
    const t = row.SETTLEMENTDATE;
    if (!t) continue;
    let bucket = scadaByTime.get(t);
    if (!bucket) { bucket = new Map(); scadaByTime.set(t, bucket); }
    bucket.set(row.DUID, Number(row.SCADAVALUE) || 0);
  }

  const units: Record<string, DayUnitAgg> = {};
  for (const duid of duids) {
    units[duid] = { mwh: 0, runIntervals: 0, runRrpWeighted: 0, runMwTotal: 0, revenue: 0 };
  }

  // Only keep intervals where at least one unit actually ran — idle intervals
  // are pure bloat since daily totals already capture them implicitly.
  const intervals: DayResult["intervals"] = [];
  const times = Array.from(scadaByTime.keys()).sort();

  for (const t of times) {
    const rrp = rrpByTime.get(t) ?? 0;
    const bucket = scadaByTime.get(t)!;
    const unitsAtT: Record<string, number> = {};
    let anyRunning = false;
    for (const duid of duids) {
      const mw = bucket.get(duid) ?? 0;
      unitsAtT[duid] = mw;
      const u = units[duid];
      u.mwh += mw * INTERVAL_HOURS;
      u.revenue += mw * rrp * INTERVAL_HOURS;
      if (mw > 0) {
        u.runIntervals += 1;
        u.runMwTotal += mw;
        u.runRrpWeighted += rrp * mw;
        anyRunning = true;
      }
    }
    if (anyRunning) intervals.push({ t: toIsoTime(t), rrp, units: unitsAtT });
  }

  return { date: isoDate, units, intervals };
}

/** Generate list of YYYY-MM-DD strings for a month, only including days that are
 *  strictly before today (archive publishes ~01:01 AM the next day). */
export function daysInMonth(isoMonth: string): string[] {
  const [y, m] = isoMonth.split("-").map(Number);
  if (!y || !m) return [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso < todayIso) out.push(iso);
  }
  return out;
}

/** Fetch + aggregate only the supplied dates (skips batches that fail transiently). */
export async function buildRevenueDays(plant: PlantKey, dates: string[]): Promise<DayResult[]> {
  const BATCH = 4;
  const out: DayResult[] = [];
  for (let i = 0; i < dates.length; i += BATCH) {
    const slice = dates.slice(i, i + BATCH);
    const settled = await Promise.allSettled(slice.map((d) => buildRevenueDay(plant, d)));
    for (const s of settled) {
      if (s.status === "fulfilled") out.push(s.value);
      else console.warn(`[revenue builder] ${plant}: day fetch failed:`, s.reason instanceof Error ? s.reason.message : s.reason);
    }
    // Free parsed archive zips so month-long builds don't blow the heap.
    clearArchiveCache();
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Fetch + aggregate every available day of a month. Runs in small batches to avoid
 *  hammering AEMO. Days that fail (e.g. archive not yet published) are skipped. */
export async function buildRevenueMonth(plant: PlantKey, month: string): Promise<MonthResult> {
  const { duids, region } = PLANTS[plant];
  const dates = daysInMonth(month);
  const days = await buildRevenueDays(plant, dates);

  return {
    plant,
    duids,
    region,
    month,
    generatedAt: new Date().toISOString(),
    days,
  };
}
