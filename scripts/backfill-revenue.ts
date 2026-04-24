/**
 * Incrementally fill missing days in data/revenue/{plant}/{YYYY-MM}.json.
 * Reads the existing JSON, compares against daysInMonth(), and fetches only
 * the gaps. Unlike build-revenue-archive.ts this also handles the current
 * month and never refetches days already on disk.
 *
 * Usage:
 *   npx tsx scripts/backfill-revenue.ts                      # all plants, current month
 *   npx tsx scripts/backfill-revenue.ts --month 2026-04      # all plants, specific month
 *   npx tsx scripts/backfill-revenue.ts --plant bdl          # single plant, current month
 */

import { promises as fs } from "fs";
import path from "path";
import { buildRevenueDays, daysInMonth, PLANTS, type PlantKey, type MonthResult } from "../lib/revenue/builder";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function backfillOne(plant: PlantKey, month: string): Promise<void> {
  const dir = path.join(process.cwd(), "data", "revenue", plant);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${month}.json`);

  let existing: MonthResult | null = null;
  try {
    existing = JSON.parse(await fs.readFile(file, "utf-8")) as MonthResult;
  } catch { /* no file yet */ }

  const targetDates = daysInMonth(month);
  const haveDates = new Set(existing?.days.map((d) => d.date) ?? []);
  const missing = targetDates.filter((d) => !haveDates.has(d));

  if (missing.length === 0) {
    console.log(`  ✓ ${plant}/${month} — up to date (${haveDates.size} days)`);
    return;
  }

  console.log(`  → ${plant}/${month} — fetching ${missing.length} missing day(s): ${missing.join(", ")}`);
  const start = Date.now();
  const newDays = await buildRevenueDays(plant, missing);

  const merged = new Map<string, (typeof newDays)[number]>();
  for (const d of existing?.days ?? []) merged.set(d.date, d);
  for (const d of newDays) merged.set(d.date, d);
  const days = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));

  const { duids, region } = PLANTS[plant];
  const result: MonthResult = {
    plant, duids, region, month,
    generatedAt: new Date().toISOString(),
    days,
  };

  await fs.writeFile(file, JSON.stringify(result, null, 0) + "\n");
  const size = (await fs.stat(file)).size;
  console.log(`  ✓ ${plant}/${month} — now ${days.length} days, ${(size / 1024).toFixed(0)} KB, ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function main() {
  const args = process.argv.slice(2);
  const monthIdx = args.indexOf("--month");
  const plantIdx = args.indexOf("--plant");
  const month = monthIdx >= 0 ? args[monthIdx + 1] : currentMonth();
  const plantArg = plantIdx >= 0 ? args[plantIdx + 1] : null;

  const plants: PlantKey[] = plantArg
    ? [plantArg as PlantKey]
    : ["braemar", "bdl"];

  console.log(`Backfilling revenue: ${plants.join(", ")} × ${month}`);
  console.log("");

  for (const plant of plants) {
    try {
      await backfillOne(plant, month);
    } catch (e) {
      console.error(`  ✗ ${plant}/${month} — failed:`, e instanceof Error ? e.message : e);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
