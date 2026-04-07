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
  aest.setUTCMinutes(aest.getUTCMinutes() - 10);
  const y = aest.getUTCFullYear();
  const mo = String(aest.getUTCMonth() + 1).padStart(2, "0");
  const d = String(aest.getUTCDate()).padStart(2, "0");
  const h = String(aest.getUTCHours()).padStart(2, "0");
  const m = String(aest.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${m}`;
}

/** Parse interval DateTime "2026-04-07 17:10:00" → ISO "2026-04-07T17:10:00" */
function normaliseInterval(dt: string): string {
  return dt.replace(" ", "T");
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
 * Find the two latest P5MIN run columns from the data.
 * Columns are like "07 19:10.rrp" — each represents a P5MIN run.
 * Returns [previousRunCol, currentRunCol] sorted by run time descending.
 */
function findLatestTwoRunColumns(data: Record<string, unknown>[]): [string, string] | null {
  // Collect all .rrp column names that have at least one non-null value
  const colsWithData = new Set<string>();
  for (const row of data) {
    for (const [key, val] of Object.entries(row)) {
      if (key.endsWith(".rrp") && val !== null && typeof val === "number") {
        colsWithData.add(key);
      }
    }
  }

  if (colsWithData.size < 2) return null;

  // Sort columns by time descending (e.g., "07 19:10.rrp" > "07 19:05.rrp")
  const sorted = [...colsWithData].sort((a, b) => b.localeCompare(a));
  return [sorted[1], sorted[0]]; // [previous, current]
}

/**
 * Extract price changes by comparing the two latest P5MIN run columns.
 * Rows = intervals, columns = runs.
 */
function extractChanges(data: Record<string, unknown>[], region: string): P5PriceRow[] {
  const cols = findLatestTwoRunColumns(data);
  if (!cols) return [];
  const [prevCol, curCol] = cols;

  const results: P5PriceRow[] = [];
  for (const row of data) {
    const dt = row.DateTime as string | undefined;
    if (!dt) continue;

    const curVal = row[curCol];
    const prevVal = row[prevCol];
    if (curVal === null || curVal === undefined || typeof curVal !== "number") continue;
    if (prevVal === null || prevVal === undefined || typeof prevVal !== "number") continue;

    results.push({
      INTERVAL_DATETIME: normaliseInterval(dt),
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
 * Uses "Prices Hour ahead forecasts" with period=Two Hours.
 * Rows = intervals, columns = P5MIN runs. We compare the last two run columns.
 *
 * Returns the same shape as the old NEMWeb getP5MinPriceChanges().
 */
export async function getNeopointP5MinPriceChanges(): Promise<P5PriceRow[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  // Fetch all regions in parallel
  const regionData = await Promise.all(REGIONS.map((r) => fetchRegion(r, apiKey)));

  const allResults: P5PriceRow[] = [];
  for (let i = 0; i < REGIONS.length; i++) {
    allResults.push(...extractChanges(regionData[i], REGIONS[i]));
  }

  if (allResults.length === 0) {
    throw new Error("Neopoint: no overlapping intervals between runs");
  }

  allResults.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return allResults;
}
