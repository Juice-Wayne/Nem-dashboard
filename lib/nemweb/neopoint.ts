const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";
const REGIONS = ["NSW1", "QLD1", "VIC1", "SA1"];

type P5PriceRow = {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  CURRENT_RRP: number;
  PREVIOUS_RRP: number;
  DELTA: number;
};

/** Build the AEST "from" param: current time minus 10 min buffer */
function aestFrom(): string {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  // Go back 10 minutes to ensure we capture the current + previous runs
  aest.setUTCMinutes(aest.getUTCMinutes() - 10);
  const y = aest.getUTCFullYear();
  const mo = String(aest.getUTCMonth() + 1).padStart(2, "0");
  const d = String(aest.getUTCDate()).padStart(2, "0");
  const h = String(aest.getUTCHours()).padStart(2, "0");
  const m = String(aest.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${m}`;
}

/** Parse column key like "07 17:10.rrp" into ISO datetime */
function parseIntervalKey(key: string, baseYear: number, baseMonth: number, baseDay: number): string | null {
  const match = key.match(/^(\d{2})\s+(\d{2}):(\d{2})\.rrp$/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const hour = parseInt(match[2]);
  const min = parseInt(match[3]);

  // Handle month rollover (e.g., query on March 31, column shows "01")
  let month = baseMonth;
  if (day < baseDay - 15) month++;

  return `${baseYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
}

/** Count non-null numeric .rrp values in a row */
function countRrp(row: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith(".rrp") && v !== null && typeof v === "number") n++;
  }
  return n;
}

/** Find the best consecutive pair of runs with the most overlapping intervals */
function findBestPair(
  data: Record<string, unknown>[],
): [Record<string, unknown>, Record<string, unknown>] | null {
  const withData = data.filter((row) => countRrp(row) >= 1);
  if (withData.length < 2) return null;

  let bestPair: [Record<string, unknown>, Record<string, unknown>] | null = null;
  let bestOverlap = 0;

  for (let i = withData.length - 1; i >= 1; i--) {
    let overlap = 0;
    for (const [k, v] of Object.entries(withData[i])) {
      if (k.endsWith(".rrp") && v !== null && typeof v === "number") {
        const pv = withData[i - 1][k];
        if (pv !== null && pv !== undefined && typeof pv === "number") overlap++;
      }
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestPair = [withData[i - 1], withData[i]];
    }
    if (withData.length - 1 - i > 15) break;
  }

  return bestOverlap >= 2 ? bestPair : null;
}

/** Fetch hour-ahead forecast data from Neopoint for one region */
async function fetchRegion(region: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const from = aestFrom();
  const url = `${NEOPOINT_BASE}?f=101%20Prices%5CPrices%20Hour%20ahead%20forecasts&from=${encodeURIComponent(from)}&period=Two%20Hours&instances=${region}&section=-1&key=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Neopoint ${region}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch P5MIN price changes from Neopoint for all NEM regions.
 * Uses "Prices Hour ahead forecasts" with period=Two Hours and a tight from= window.
 * The response contains every P5MIN run as a row with forecast columns —
 * we compare the last two runs with the most overlapping intervals.
 *
 * Returns the same shape as getP5MinPriceChanges() from NEMWeb.
 * Throws on failure — caller should catch and fall back to NEMWeb.
 */
export async function getNeopointP5MinPriceChanges(): Promise<P5PriceRow[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const baseYear = aest.getUTCFullYear();
  const baseMonth = aest.getUTCMonth() + 1;
  const baseDay = aest.getUTCDate();

  // Fetch all regions in parallel
  const regionData = await Promise.all(REGIONS.map((r) => fetchRegion(r, apiKey)));

  const allResults: P5PriceRow[] = [];

  for (let i = 0; i < REGIONS.length; i++) {
    const pair = findBestPair(regionData[i]);
    if (!pair) continue;
    const [prevRun, curRun] = pair;

    for (const [key, curVal] of Object.entries(curRun)) {
      if (!key.endsWith(".rrp")) continue;
      if (curVal === null || typeof curVal !== "number") continue;
      const prevVal = prevRun[key];
      if (prevVal === null || prevVal === undefined || typeof prevVal !== "number") continue;

      const interval = parseIntervalKey(key, baseYear, baseMonth, baseDay);
      if (!interval) continue;

      allResults.push({
        INTERVAL_DATETIME: interval,
        REGIONID: REGIONS[i],
        CURRENT_RRP: curVal,
        PREVIOUS_RRP: prevVal,
        DELTA: curVal - prevVal,
      });
    }
  }

  if (allResults.length === 0) {
    throw new Error("Neopoint: no overlapping intervals between runs");
  }

  allResults.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return allResults;
}
