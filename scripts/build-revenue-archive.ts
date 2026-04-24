/**
 * Build the immutable revenue JSON archive.
 *
 * Writes data/revenue/{plant}/{YYYY-MM}.json for every month from 2026-01 up to
 * (but not including) the current month. The current month is always aggregated
 * live by the API route — we don't freeze it to disk.
 *
 * Usage:
 *   npx tsx scripts/build-revenue-archive.ts                 # fill in any gaps
 *   npx tsx scripts/build-revenue-archive.ts --force         # rebuild everything
 *   npx tsx scripts/build-revenue-archive.ts --month 2026-02 # single month, both plants
 */

import { promises as fs } from "fs";
import path from "path";
import { buildRevenueMonth, PLANTS, type PlantKey } from "../lib/revenue/builder";

const ARCHIVE_START = "2025-04";

function listMonthsThroughPrevious(): string[] {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  const [sY, sM] = ARCHIVE_START.split("-").map(Number);
  const out: string[] = [];
  for (let y = sY; y <= curY; y++) {
    const from = y === sY ? sM : 1;
    // Stop at the month BEFORE the current month — current month is live-aggregated.
    const to = y === curY ? curM - 1 : 12;
    for (let m = from; m <= to; m++) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
    }
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function buildOne(plant: PlantKey, month: string, force: boolean): Promise<void> {
  const dir = path.join(process.cwd(), "data", "revenue", plant);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${month}.json`);

  if (!force && await exists(file)) {
    console.log(`  ✓ ${plant}/${month} — already built`);
    return;
  }

  console.log(`  → ${plant}/${month} — fetching…`);
  const start = Date.now();
  const result = await buildRevenueMonth(plant, month);
  await fs.writeFile(file, JSON.stringify(result, null, 0) + "\n");
  const size = (await fs.stat(file)).size;
  const activeDays = result.days.filter((d) =>
    PLANTS[plant].duids.some((u) => (d.units[u]?.mwh ?? 0) > 0.5),
  ).length;
  console.log(
    `  ✓ ${plant}/${month} — ${result.days.length} days (${activeDays} active), ${(size / 1024).toFixed(0)} KB, ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const monthArg = args.indexOf("--month");
  const single = monthArg >= 0 ? args[monthArg + 1] : null;

  const months = single ? [single] : listMonthsThroughPrevious();
  const plants: PlantKey[] = ["braemar", "bdl"];

  console.log(`Building revenue archive: ${plants.length} plants × ${months.length} months${force ? " [FORCE]" : ""}`);
  console.log(`Months: ${months.join(", ")}`);
  console.log("");

  for (const plant of plants) {
    for (const month of months) {
      try {
        await buildOne(plant, month, force);
      } catch (e) {
        console.error(`  ✗ ${plant}/${month} — failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
