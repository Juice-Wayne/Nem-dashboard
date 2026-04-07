const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";
const REGIONS = ["NSW1", "QLD1", "VIC1", "SA1"];

type P5PriceRow = {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  CURRENT_RRP: number;
  PREVIOUS_RRP: number;
  DELTA: number;
};

// --- Server-side storage for previous P5MIN run ---
// Persists while the Vercel function is warm. On cold start, first request
// falls back to NEMWeb; from the second poll onward we have both runs.

type P5Snapshot = Map<string, number>; // key = "INTERVAL|REGION" → price
let storedPrevious: P5Snapshot | null = null;
let storedFirstInterval: string | null = null;

/** Build the Neopoint "Latest P5Min" URL for today */
function buildUrl(apiKey: string): string {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const y = aest.getUTCFullYear();
  const mo = String(aest.getUTCMonth() + 1).padStart(2, "0");
  const d = String(aest.getUTCDate()).padStart(2, "0");
  const from = `${y}-${mo}-${d} 00:00`;
  return `${NEOPOINT_BASE}?f=101%20Prices%5CLatest%20P5Min%20price%20for%20all%20regions&from=${encodeURIComponent(from)}&period=Daily&instances=&section=-1&key=${apiKey}`;
}

/** Parse Neopoint's response into a snapshot map */
function parseSnapshot(
  data: Record<string, unknown>[],
): { snapshot: P5Snapshot; firstInterval: string } | null {
  if (!Array.isArray(data) || data.length === 0) return null;

  const snapshot: P5Snapshot = new Map();
  let firstInterval: string | null = null;

  for (const row of data) {
    const dt = row.DateTime as string | undefined;
    if (!dt) continue;
    const interval = dt.replace(" ", "T");
    if (!firstInterval) firstInterval = interval;

    for (const region of REGIONS) {
      const price = row[`${region}.P5min_Price`];
      if (price !== null && price !== undefined && typeof price === "number") {
        snapshot.set(`${interval}|${region}`, price);
      }
    }
  }

  if (!firstInterval || snapshot.size === 0) return null;
  return { snapshot, firstInterval };
}

/**
 * Fetch latest P5MIN prices from Neopoint and compare with the stored previous run.
 * Returns the same shape as getP5MinPriceChanges() from NEMWeb.
 * Throws on failure — caller should catch and fall back to NEMWeb.
 */
export async function getNeopointP5MinPriceChanges(): Promise<P5PriceRow[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  const res = await fetch(buildUrl(apiKey), { cache: "no-store" });
  if (!res.ok) throw new Error(`Neopoint: HTTP ${res.status}`);
  const data = await res.json();

  const parsed = parseSnapshot(data);
  if (!parsed) throw new Error("Neopoint: empty or malformed response");

  const { snapshot: currentSnapshot, firstInterval } = parsed;

  // First request after cold start: store and fall back to NEMWeb
  if (!storedPrevious) {
    storedPrevious = currentSnapshot;
    storedFirstInterval = firstInterval;
    throw new Error("Neopoint: no previous run stored yet (cold start)");
  }

  // Compare current against stored previous
  const results: P5PriceRow[] = [];
  for (const [key, curPrice] of currentSnapshot) {
    const prevPrice = storedPrevious.get(key);
    if (prevPrice === undefined) continue;
    const [interval, region] = key.split("|");
    results.push({
      INTERVAL_DATETIME: interval,
      REGIONID: region,
      CURRENT_RRP: curPrice,
      PREVIOUS_RRP: prevPrice,
      DELTA: curPrice - prevPrice,
    });
  }

  // If this is a new P5MIN run (first interval shifted), rotate the snapshot
  if (firstInterval !== storedFirstInterval) {
    storedPrevious = currentSnapshot;
    storedFirstInterval = firstInterval;
  }

  if (results.length === 0) {
    throw new Error("Neopoint: no overlapping intervals between runs");
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return results;
}
