const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";
const REGIONS = ["NSW1", "QLD1", "VIC1", "SA1"];

type P5PriceRow = {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  CURRENT_RRP: number;
  PREVIOUS_RRP: number;
  DELTA: number;
};

/** Get the AEST "today" date string YYYY-MM-DD and current hour start HH:00 */
function aestFromParam(): string {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = aest.getUTCFullYear();
  const mo = String(aest.getUTCMonth() + 1).padStart(2, "0");
  const d = String(aest.getUTCDate()).padStart(2, "0");
  // Go back 2 hours to ensure we capture enough run history
  const h = String(Math.max(0, aest.getUTCHours() - 2)).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:00`;
}

/** Parse column key like "07 17:10.rrp" into ISO datetime using the base date */
function parseIntervalKey(key: string, baseYear: number, baseMonth: number): string | null {
  const match = key.match(/^(\d{2})\s+(\d{2}):(\d{2})\.rrp$/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const hour = parseInt(match[2]);
  const min = parseInt(match[3]);

  // Determine month: if the day is much smaller than the base date's day,
  // it's likely the next month (e.g., querying March 31, column "01 02:00")
  let month = baseMonth;
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const today = aest.getUTCDate();
  if (day < today - 15) {
    month = baseMonth + 1;
    if (month > 12) month = 1; // year rollover handled by Date constructor
  }

  const y = baseYear;
  const m = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mm = String(min).padStart(2, "0");
  return `${y}-${m}-${dd}T${hh}:${mm}:00`;
}

/** Fetch hour-ahead forecast data from Neopoint for a single region */
async function fetchRegionForecasts(
  region: string,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const from = aestFromParam();
  const url = `${NEOPOINT_BASE}?f=101%20Prices%5CPrices%20Hour%20ahead%20forecasts&from=${encodeURIComponent(from)}&period=Daily&instances=${region}&section=-1&key=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Neopoint ${region}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(`Neopoint ${region}: need >= 2 runs, got ${Array.isArray(data) ? data.length : 0}`);
  }
  return data;
}

/** Count non-null .rrp values in a row */
function countRrpValues(row: Record<string, unknown>): number {
  return Object.entries(row).filter(([k, v]) => k.endsWith(".rrp") && v !== null && typeof v === "number").length;
}

/** Find the last two runs with meaningful data (>= 5 forecast intervals each) */
function findLastTwoRuns(data: Record<string, unknown>[]): [Record<string, unknown>, Record<string, unknown>] | null {
  const MIN_INTERVALS = 5;
  // Walk backwards to find the latest run with enough data
  for (let i = data.length - 1; i >= 1; i--) {
    if (countRrpValues(data[i]) >= MIN_INTERVALS && countRrpValues(data[i - 1]) >= MIN_INTERVALS) {
      return [data[i - 1], data[i]];
    }
  }
  return null;
}

/** Extract price changes from last two valid runs of Neopoint forecast data */
function extractChanges(
  data: Record<string, unknown>[],
  region: string,
  baseYear: number,
  baseMonth: number,
): P5PriceRow[] {
  const runs = findLastTwoRuns(data);
  if (!runs) return [];
  const [prevRun, curRun] = runs;
  const results: P5PriceRow[] = [];

  for (const key of Object.keys(curRun)) {
    if (!key.endsWith(".rrp")) continue;

    const curVal = curRun[key];
    const prevVal = prevRun[key];
    if (curVal == null || prevVal == null) continue;
    if (typeof curVal !== "number" || typeof prevVal !== "number") continue;

    const interval = parseIntervalKey(key, baseYear, baseMonth);
    if (!interval) continue;

    results.push({
      INTERVAL_DATETIME: interval,
      REGIONID: region,
      CURRENT_RRP: curVal,
      PREVIOUS_RRP: prevVal,
      DELTA: curVal - prevVal,
    });
  }

  return results;
}

/**
 * Fetch P5MIN price changes from Neopoint for all NEM regions.
 * Returns the same shape as getP5MinPriceChanges() from NEMWeb.
 * Throws on failure — caller should catch and fall back to NEMWeb.
 */
export async function getNeopointP5MinPriceChanges(): Promise<P5PriceRow[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const baseYear = aest.getUTCFullYear();
  const baseMonth = aest.getUTCMonth() + 1;

  // Fetch all regions in parallel
  const regionData = await Promise.all(
    REGIONS.map((r) => fetchRegionForecasts(r, apiKey)),
  );

  const allResults: P5PriceRow[] = [];
  for (let i = 0; i < REGIONS.length; i++) {
    const changes = extractChanges(regionData[i], REGIONS[i], baseYear, baseMonth);
    allResults.push(...changes);
  }

  if (allResults.length === 0) {
    throw new Error("Neopoint: no overlapping intervals between runs");
  }

  // Sort by absolute delta descending (same as NEMWeb version)
  allResults.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return allResults;
}
