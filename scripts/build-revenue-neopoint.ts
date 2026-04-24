/**
 * Backfill revenue JSONs for periods that predate AEMO's 13-month archive window
 * (currently: Jan / Feb / Mar 2025) by pulling data from NeoPoint instead.
 *
 * NeoPoint reports used:
 *   101 Prices\Region Price 5min              → 5-min RRP per region
 *   103 Generation and Load\DUID Gen and Load (SCADA) → 5-min SCADA MW per DUID
 *
 * Each call fetches a full quarter in one JSON. We split the rows into per-day
 * per-month aggregates and write the same MonthResult shape the rest of the app
 * already reads (data/revenue/{plant}/{YYYY-MM}.json).
 *
 * Usage:
 *   npx tsx scripts/build-revenue-neopoint.ts 2025-Q1
 *   npx tsx scripts/build-revenue-neopoint.ts 2025-Q1 --force
 */

import { promises as fs, readFileSync, existsSync } from "fs";
import path from "path";
import { PLANTS, type PlantKey, type DayResult, type DayUnitAgg, type MonthResult } from "../lib/revenue/builder";

// Minimal .env.local loader (Next.js loads these at runtime, but CLI scripts don't).
function loadDotEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const [, key, valRaw] = m;
    if (process.env[key]) continue;
    const val = valRaw.replace(/^["']|["']$/g, "");
    process.env[key] = val;
  }
}
loadDotEnvLocal();

const INTERVAL_HOURS = 5 / 60;
const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";

type PriceRow = Record<string, string | number | null>;
type ScadaRow = Record<string, string | number | null>;

function apiKey(): string {
  const k = process.env.NEOPOINT_API_KEY;
  if (!k) throw new Error("NEOPOINT_API_KEY not set (check .env.local)");
  return k;
}

/** Quarter id → { start ISO date, months array } */
function parseQuarter(q: string): { startIso: string; months: string[] } {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) throw new Error(`quarter must be YYYY-Qn, got ${q}`);
  const y = Number(m[1]);
  const qn = Number(m[2]);
  const startMonth = (qn - 1) * 3 + 1;
  const months = [0, 1, 2].map((i) => `${y}-${String(startMonth + i).padStart(2, "0")}`);
  const startIso = `${y}-${String(startMonth).padStart(2, "0")}-01`;
  return { startIso, months };
}

async function npFetch(params: URLSearchParams): Promise<Record<string, unknown>[]> {
  params.set("key", apiKey());
  const url = `${NEOPOINT_BASE}?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`NeoPoint ${res.status}: ${url}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`NeoPoint returned non-array: ${JSON.stringify(json).slice(0, 200)}`);
  return json as Record<string, unknown>[];
}

/** Fetch one region's 5-min price for a quarter. Row shape: { DateTime, "QLD1.Price 5min": rrp } */
async function fetchRegionPriceQuarter(region: string, startIso: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    f: "101 Prices\\Region Price 5min",
    from: `${startIso} 00:00`,
    period: "Quarterly",
    instances: region,
    section: "-1",
  });
  const rows = await npFetch(params);
  const priceKey = `${region}.Price 5min`;
  const map = new Map<string, number>();
  for (const r of rows as PriceRow[]) {
    const dt = r.DateTime as string;
    const price = r[priceKey];
    if (!dt || typeof price !== "number") continue;
    map.set(dt, price);
  }
  return map;
}

/** Fetch one DUID's 5-min SCADA GEN for a quarter. Row shape: { DateTime, "BRAEMAR1.ScadaValue_GEN": mw } */
async function fetchDuidScadaQuarter(duid: string, startIso: string): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    f: "103 Generation and Load\\DUID Gen and Load (SCADA)",
    from: `${startIso} 00:00`,
    period: "Quarterly",
    instances: duid,
    section: "-1",
  });
  const rows = await npFetch(params);
  const genKey = `${duid}.ScadaValue_GEN`;
  const map = new Map<string, number>();
  for (const r of rows as ScadaRow[]) {
    const dt = r.DateTime as string;
    const mw = r[genKey];
    if (!dt) continue;
    map.set(dt, typeof mw === "number" ? mw : 0);
  }
  return map;
}

/** "2025-01-01 00:05:00" → "2025-01-01" */
function dateOf(dt: string): string { return dt.slice(0, 10); }
/** "2025-01-01 00:05:00" → "2025-01-01T00:05:00" */
function toIso(dt: string): string { return dt.replace(" ", "T"); }
function monthOf(iso: string): string { return iso.slice(0, 7); }

/** Aggregate NeoPoint data into per-day DayResult records for a plant, for one quarter. */
function aggregateQuarter(
  plant: PlantKey,
  rrpByTime: Map<string, number>,
  scadaByDuidByTime: Map<string, Map<string, number>>,
): DayResult[] {
  const { duids } = PLANTS[plant];

  // Collect the set of all 5-min timestamps we have any data for
  const allTimes = new Set<string>();
  for (const t of rrpByTime.keys()) allTimes.add(t);
  for (const m of scadaByDuidByTime.values()) for (const t of m.keys()) allTimes.add(t);

  // Bucket by date
  const byDate = new Map<string, string[]>();
  for (const t of allTimes) {
    const d = dateOf(t);
    const b = byDate.get(d);
    if (b) b.push(t); else byDate.set(d, [t]);
  }

  const days: DayResult[] = [];
  for (const [date, times] of byDate) {
    times.sort();

    const units: Record<string, DayUnitAgg> = {};
    for (const duid of duids) {
      units[duid] = { mwh: 0, runIntervals: 0, runRrpWeighted: 0, runMwTotal: 0, revenue: 0 };
    }

    const intervals: DayResult["intervals"] = [];
    for (const t of times) {
      const rrp = rrpByTime.get(t) ?? 0;
      const unitsAtT: Record<string, number> = {};
      let anyRunning = false;
      for (const duid of duids) {
        const mw = scadaByDuidByTime.get(duid)?.get(t) ?? 0;
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
      if (anyRunning) intervals.push({ t: toIso(t), rrp, units: unitsAtT });
    }

    days.push({ date, units, intervals });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

/** Split per-day days[] into month buckets for writing. */
function splitByMonth(plant: PlantKey, days: DayResult[], months: string[]): Map<string, MonthResult> {
  const { duids, region } = PLANTS[plant];
  const generatedAt = new Date().toISOString();
  const buckets = new Map<string, MonthResult>();
  for (const m of months) {
    buckets.set(m, { plant, duids, region, month: m, generatedAt, days: [] });
  }
  for (const d of days) {
    const bucket = buckets.get(monthOf(d.date));
    if (bucket) bucket.days.push(d);
  }
  return buckets;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function buildPlantQuarter(plant: PlantKey, startIso: string, months: string[], force: boolean): Promise<void> {
  const { duids, region } = PLANTS[plant];

  // Skip if all target files already exist (unless --force)
  const dir = path.join(process.cwd(), "data", "revenue", plant);
  await fs.mkdir(dir, { recursive: true });
  if (!force) {
    const allPresent = await Promise.all(months.map((m) => fileExists(path.join(dir, `${m}.json`)))).then((a) => a.every(Boolean));
    if (allPresent) {
      console.log(`  ✓ ${plant} — all ${months.length} months already built`);
      return;
    }
  }

  console.log(`  → ${plant} — fetching RRP (${region}) + SCADA for ${duids.join(", ")}`);
  const startedAt = Date.now();

  const rrpByTime = await fetchRegionPriceQuarter(region, startIso);
  const scadaByDuid = new Map<string, Map<string, number>>();
  for (const duid of duids) {
    scadaByDuid.set(duid, await fetchDuidScadaQuarter(duid, startIso));
  }

  const days = aggregateQuarter(plant, rrpByTime, scadaByDuid);
  const byMonth = splitByMonth(plant, days, months);

  for (const [m, result] of byMonth) {
    const file = path.join(dir, `${m}.json`);
    await fs.writeFile(file, JSON.stringify(result, null, 0) + "\n");
    const size = (await fs.stat(file)).size;
    const active = result.days.filter((d) => duids.some((u) => (d.units[u]?.mwh ?? 0) > 0.5)).length;
    console.log(`    ✓ ${plant}/${m} — ${result.days.length} days (${active} active), ${(size / 1024).toFixed(0)} KB`);
  }

  console.log(`  ${plant} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const quarter = args.find((a) => /^\d{4}-Q[1-4]$/.test(a));
  if (!quarter) throw new Error("usage: build-revenue-neopoint.ts <YYYY-Qn> [--force]");

  const { startIso, months } = parseQuarter(quarter);
  console.log(`NeoPoint backfill: ${quarter} → months ${months.join(", ")} starting ${startIso}${force ? " [FORCE]" : ""}`);

  const plants: PlantKey[] = ["braemar", "bdl"];
  for (const p of plants) {
    try {
      await buildPlantQuarter(p, startIso, months, force);
    } catch (e) {
      console.error(`  ✗ ${p} failed:`, e instanceof Error ? e.message : e);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
