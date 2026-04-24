import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { PLANTS, buildRevenueDays, daysInMonth, type PlantKey, type MonthResult } from "@/lib/revenue/builder";

// --- Disk-backed cache ---------------------------------------------------
//
// Past months are immutable — we commit their aggregated JSON to data/revenue/
// and serve from there on Vercel.
//
// Current month is incrementally filled: we persist whatever complete days we
// already have and only fetch the ones missing (i.e. days between last saved
// day and yesterday). Today isn't fetched — AEMO only publishes the archive
// zip ~01:01 AM the next day.

const DATA_DIR = path.join(process.cwd(), "data", "revenue");

function monthFilePath(plant: PlantKey, month: string): string {
  return path.join(DATA_DIR, plant, `${month}.json`);
}

async function readMonthFromDisk(plant: PlantKey, month: string): Promise<MonthResult | null> {
  try {
    const text = await fs.readFile(monthFilePath(plant, month), "utf-8");
    return JSON.parse(text) as MonthResult;
  } catch {
    return null;
  }
}

async function writeMonthToDisk(plant: PlantKey, month: string, result: MonthResult): Promise<void> {
  const file = monthFilePath(plant, month);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(result, null, 0) + "\n");
  } catch (e) {
    // On Vercel the filesystem is read-only outside /tmp — swallow the write error
    // and rely on the in-memory cache. Locally the write succeeds and the JSON is
    // committable.
    console.warn("[revenue] could not persist month to disk:", e instanceof Error ? e.message : e);
  }
}

// In-memory cache — covers the read-only serverless environment where we can't write back.
const memCache = new Map<string, { data: MonthResult; expiry: number }>();
const MEM_TTL = 10 * 60 * 1000; // 10min — short so new days land promptly after archive publish

function isCurrentMonth(month: string): boolean {
  const now = new Date();
  const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return month === curMonth;
}

async function loadMonth(plant: PlantKey, month: string): Promise<MonthResult> {
  const cacheKey = `${plant}:${month}`;

  // Past months: disk is the source of truth. No network calls.
  if (!isCurrentMonth(month)) {
    const disk = await readMonthFromDisk(plant, month);
    if (disk) return disk;
    // Fallback: if the disk file is missing for a past month (e.g. not yet backfilled),
    // fetch it live once and cache. Don't persist — user should run build:revenue explicitly.
    const cached = memCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) return cached.data;
    const { duids, region } = PLANTS[plant];
    const days = await buildRevenueDays(plant, daysInMonth(month));
    const result: MonthResult = { plant, duids, region, month, generatedAt: new Date().toISOString(), days };
    memCache.set(cacheKey, { data: result, expiry: Date.now() + MEM_TTL });
    return result;
  }

  // Current month: incremental fill.
  const cached = memCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) return cached.data;

  const existing = await readMonthFromDisk(plant, month);
  const targetDates = daysInMonth(month); // all archive-published dates (< today) in this month
  const haveDates = new Set(existing?.days.map((d) => d.date) ?? []);
  const missing = targetDates.filter((d) => !haveDates.has(d));

  const { duids, region } = PLANTS[plant];
  if (missing.length === 0) {
    const result = existing ?? {
      plant, duids, region, month, generatedAt: new Date().toISOString(), days: [],
    };
    memCache.set(cacheKey, { data: result, expiry: Date.now() + MEM_TTL });
    return result;
  }

  console.log(`[revenue] ${plant}/${month}: fetching ${missing.length} missing day(s): ${missing.join(", ")}`);
  const newDays = await buildRevenueDays(plant, missing);

  // Merge existing + new (new entries win if any overlap) and sort by date.
  const merged = new Map<string, typeof newDays[number]>();
  for (const d of existing?.days ?? []) merged.set(d.date, d);
  for (const d of newDays) merged.set(d.date, d);
  const days = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));

  const result: MonthResult = {
    plant, duids, region, month,
    generatedAt: new Date().toISOString(),
    days,
  };

  await writeMonthToDisk(plant, month, result);
  memCache.set(cacheKey, { data: result, expiry: Date.now() + MEM_TTL });
  return result;
}

// --- Route ---------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const plantParam = sp.get("plant");
    if (plantParam !== "braemar" && plantParam !== "bdl") {
      return NextResponse.json({ error: "plant must be 'braemar' or 'bdl'" }, { status: 400 });
    }
    const plant = plantParam as PlantKey;

    const day = sp.get("day");
    const month = sp.get("month");

    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return NextResponse.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
      }
      const monthOf = day.slice(0, 7);
      const result = await loadMonth(plant, monthOf);
      const dayResult = result.days.find((d) => d.date === day);
      if (!dayResult) {
        return NextResponse.json(
          { plant, duids: PLANTS[plant].duids, region: PLANTS[plant].region, date: day, units: {}, intervals: [] },
          { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
        );
      }
      return NextResponse.json(
        { plant, duids: PLANTS[plant].duids, region: PLANTS[plant].region, ...dayResult },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
      );
    }

    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
      }
      const result = await loadMonth(plant, month);
      // Month response strips per-interval detail (sent on day drill-down only).
      const days = result.days.map((d) => ({ date: d.date, units: d.units }));
      return NextResponse.json(
        { plant, duids: PLANTS[plant].duids, region: PLANTS[plant].region, month, days },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
      );
    }

    return NextResponse.json({ error: "specify month=YYYY-MM or day=YYYY-MM-DD" }, { status: 400 });
  } catch (e) {
    console.error("[revenue] API error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
