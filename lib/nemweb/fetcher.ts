import JSZip from "jszip";
import { parseNEMWebCSV } from "./csv-parser";

const BASE = "https://nemweb.com.au";
const FETCH_OPTS: RequestInit = {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; NEMDashboard/1.0)" },
  cache: "no-store",
};

// --- Cache infrastructure ---

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const dirCache = new Map<string, CacheEntry<string[]>>();
const csvCache = new Map<string, CacheEntry<Map<string, Record<string, string>[]>>>();

const DIR_TTL = 5_000;    // 5s — check for new AEMO files frequently (cheap HTML scrape)
const CSV_TTL = 300_000;  // 5min — files are immutable once published

/** Clear directory cache — used for forced refresh to pick up newly published files */
export function clearDirCache(): void {
  dirCache.clear();
}

/** Clear CSV cache — used for forced refresh to guarantee fresh file parses */
export function clearCsvCache(): void {
  csvCache.clear();
}

// In-flight request deduplication to avoid hammering AEMO with concurrent fetches
const inflight = new Map<string, Promise<unknown>>();

function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// --- Concurrency limiter (avoid AEMO rate-limits) ---

const MAX_CONCURRENT = 3;
let active = 0;
const queue: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(() => { active++; resolve(); }));
}

function releaseSlot(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

// --- Retry helper ---

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  await acquireSlot();
  try {
    for (let i = 0; i <= retries; i++) {
      const res = await fetch(url, FETCH_OPTS);
      if (res.ok) return res;
      if (res.status === 403 && i < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw new Error(`NEMWeb ${url}: ${res.status}`);
    }
    throw new Error(`NEMWeb ${url}: exhausted retries`);
  } finally {
    releaseSlot();
  }
}

// --- Directory listing ---

/** Scrape an AEMO NEMWeb directory listing and return ZIP file paths, newest first */
function listDirectory(path: string): Promise<string[]> {
  const cached = dirCache.get(path);
  if (cached && cached.expiry > Date.now()) return Promise.resolve(cached.data);

  return dedup(`dir:${path}`, async () => {
    const res = await fetchWithRetry(`${BASE}${path}`);
    const html = await res.text();

    const links: string[] = [];
    const re = /href="([^"]*\.zip)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      links.push(m[1]);
    }

    links.sort((a, b) => b.localeCompare(a));
    dirCache.set(path, { data: links, expiry: Date.now() + DIR_TTL });
    return links;
  });
}

// --- ZIP download & parse ---

/** Download a ZIP, extract the first CSV inside, parse AEMO format */
function fetchAndParseZip(
  url: string,
): Promise<Map<string, Record<string, string>[]>> {
  const cached = csvCache.get(url);
  if (cached && cached.expiry > Date.now()) return Promise.resolve(cached.data);

  return dedup(`zip:${url}`, async () => {
    const res = await fetchWithRetry(url);
    const buf = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    let csvText = "";
    for (const name of Object.keys(zip.files)) {
      if (name.toLowerCase().endsWith(".csv")) {
        csvText = await zip.files[name].async("text");
        break;
      }
    }

    if (!csvText) throw new Error(`No CSV found in ${url}`);

    const parsed = parseNEMWebCSV(csvText);
    csvCache.set(url, { data: parsed, expiry: Date.now() + CSV_TTL });
    return parsed;
  });
}

// --- Public helpers ---

export interface NEMWebSource {
  path: string;
  count: number; // how many latest ZIPs to fetch
}

export const SOURCES = {
  p5min: { path: "/Reports/Current/P5_Reports/", count: 2 },
  predispatch: { path: "/Reports/Current/PredispatchIS_Reports/", count: 2 },
  dispatch: { path: "/Reports/Current/DispatchIS_Reports/", count: 1 },
  sensitivities: { path: "/Reports/Current/Predispatch_Sensitivities/", count: 2 },
  // Analytics sources
  dispatchScada: { path: "/Reports/Current/Dispatch_SCADA/", count: 1 },
  bidmove: { path: "/Reports/Current/Bidmove_Complete/", count: 1 },
  stpasa: { path: "/Reports/Current/Short_Term_PASA_Reports/", count: 1 },
  stpasaDuid: { path: "/Reports/Current/STPASA_DUIDAvailability/", count: 1 },
  pdpasaDuid: { path: "/Reports/Current/PDPASA_DUIDAvailability/", count: 1 },
  mtpasaDuid: { path: "/Reports/Current/MTPASA_DUIDAvailability/", count: 1 },
  rooftopPvActual: { path: "/Reports/Current/Rooftop_PV/Actual/", count: 12 },
  rooftopPvForecast: { path: "/Reports/Current/Rooftop_PV/Forecast/", count: 1 },
} as const;

// Track the newest file per source path — when it changes, notify listeners
const lastSeenFiles = new Map<string, string>();
let onSourceChanged: ((path: string) => void) | null = null;

/** Register a callback that fires when a source directory has new files */
export function setSourceChangedCallback(cb: (path: string) => void): void {
  onSourceChanged = cb;
}

/**
 * Fetch the N latest ZIPs from a NEMWeb directory, parse all CSVs,
 * and return an array of parsed table-maps (newest first).
 */
export async function fetchLatest(
  source: NEMWebSource,
): Promise<Map<string, Record<string, string>[]>[]> {
  const links = await listDirectory(source.path);
  const toFetch = links.slice(0, source.count);

  // Detect new files → notify so result caches can be invalidated
  const sig = toFetch.join("|");
  const prev = lastSeenFiles.get(source.path);
  lastSeenFiles.set(source.path, sig);
  if (prev !== undefined && prev !== sig && onSourceChanged) {
    onSourceChanged(source.path);
  }

  // Resolve relative URLs
  const urls = toFetch.map((link) =>
    link.startsWith("http") ? link : link.startsWith("/") ? `${BASE}${link}` : `${BASE}${source.path}${link}`,
  );

  const results = await Promise.all(urls.map(fetchAndParseZip));
  return results;
}

/** Normalise AEMO datetime "2026/03/04 09:35:00" → ISO "2026-03-04T09:35:00" */
export function normaliseDate(d: string): string {
  return d.replace(/\//g, "-").replace(" ", "T");
}

// --- DUID fuel type mapping from AEMO CDEII ---

export type FuelCategory = "Coal" | "Gas" | "Hydro" | "Wind" | "Solar" | "Battery" | "Other";

const ENERGY_SOURCE_TO_CATEGORY: Record<string, FuelCategory> = {
  "Black coal": "Coal",
  "Brown coal": "Coal",
  "Natural Gas (Pipeline)": "Gas",
  "Coal seam methane": "Gas",
  "Coal mine waste gas": "Gas",
  "Ethane": "Gas",
  "Hydro": "Hydro",
  "Wind": "Wind",
  "Solar": "Solar",
  "Battery Storage": "Battery",
  // Everything else → Other (Diesel, Biomass, Landfill, Bagasse, etc.)
};

let duidFuelCache: { data: Map<string, FuelCategory>; expiry: number } | null = null;
const FUEL_TTL = 24 * 60 * 60 * 1000; // 24h — rarely changes

/** Fetch DUID → fuel category mapping from AEMO CDEII Available Generators */
export async function getDuidFuelMap(): Promise<Map<string, FuelCategory>> {
  if (duidFuelCache && Date.now() < duidFuelCache.expiry) return duidFuelCache.data;

  return dedup("duid-fuel", async () => {
    const url = `${BASE}/Reports/Current/CDEII/CO2EII_AVAILABLE_GENERATORS.CSV`;
    const res = await fetchWithRetry(url);
    const text = await res.text();

    const map = new Map<string, FuelCategory>();
    const lines = text.split("\n");

    // AEMO CSV format: record type, table, ... — I rows are headers, D rows are data
    let duidIdx = -1;
    let sourceIdx = -1;

    for (const line of lines) {
      const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols[0] === "I") {
        duidIdx = cols.indexOf("DUID");
        sourceIdx = cols.indexOf("CO2E_ENERGY_SOURCE");
      } else if (cols[0] === "D" && duidIdx >= 0 && sourceIdx >= 0) {
        const duid = cols[duidIdx];
        const source = cols[sourceIdx];
        if (duid && source) {
          map.set(duid, ENERGY_SOURCE_TO_CATEGORY[source] ?? "Other");
        }
      }
    }

    duidFuelCache = { data: map, expiry: Date.now() + FUEL_TTL };
    return map;
  });
}

export interface DuidInfo {
  fuel: FuelCategory;
  region: string;
  capacity: number;    // registered capacity MW (0 if unknown)
  stationName: string;
}

/** Fetch DUID → { fuel, region, capacity, stationName } mapping from AEMO CDEII Available Generators */
let duidInfoCache: { data: Map<string, DuidInfo>; expiry: number } | null = null;

export async function getDuidInfoMap(): Promise<Map<string, DuidInfo>> {
  if (duidInfoCache && Date.now() < duidInfoCache.expiry) return duidInfoCache.data;

  return dedup("duid-info", async () => {
    const url = `${BASE}/Reports/Current/CDEII/CO2EII_AVAILABLE_GENERATORS.CSV`;
    const res = await fetchWithRetry(url);
    const text = await res.text();

    const map = new Map<string, DuidInfo>();
    const lines = text.split("\n");

    let duidIdx = -1;
    let sourceIdx = -1;
    let regionIdx = -1;
    let capIdx = -1;
    let nameIdx = -1;

    for (const line of lines) {
      const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols[0] === "I") {
        duidIdx = cols.indexOf("DUID");
        sourceIdx = cols.indexOf("CO2E_ENERGY_SOURCE");
        regionIdx = cols.indexOf("REGIONID");
        // Try common capacity column names
        capIdx = cols.indexOf("REGISTEREDCAPACITY");
        if (capIdx < 0) capIdx = cols.indexOf("CO2E_EMISSIONS_INTENSITY");
        if (capIdx < 0) capIdx = cols.indexOf("MAXCAPACITY");
        nameIdx = cols.indexOf("STATIONNAME");
        if (nameIdx < 0) nameIdx = cols.indexOf("STATION_NAME");
      } else if (cols[0] === "D" && duidIdx >= 0 && sourceIdx >= 0) {
        const duid = cols[duidIdx];
        const source = cols[sourceIdx];
        const region = regionIdx >= 0 ? cols[regionIdx] : "";
        const capRaw = capIdx >= 0 ? cols[capIdx] : "";
        const cap = Number(capRaw);
        const name = nameIdx >= 0 ? cols[nameIdx] : "";
        if (duid && source) {
          map.set(duid, {
            fuel: ENERGY_SOURCE_TO_CATEGORY[source] ?? "Other",
            region: region || "",
            capacity: isNaN(cap) ? 0 : cap,
            stationName: name,
          });
        }
      }
    }

    duidInfoCache = { data: map, expiry: Date.now() + FUEL_TTL };
    return map;
  });
}

// --- Archive fetcher (historical daily zips) -------------------------------
//
// AEMO's /Reports/Archive/{report}/ holds one zip per day (PUBLIC_{REPORT}_YYYYMMDD.zip).
// Each daily zip is a container of ~288 inner zips (one per 5-min dispatch interval),
// and each inner zip holds one CSV. To get a full day's data we download the outer
// zip, iterate every inner .zip entry, unzip it, parse the CSV, and merge into one
// table-map keyed by compound "report_table" names (same as parseNEMWebCSV).

const ARCHIVE_DAY_TTL_PAST = 24 * 60 * 60 * 1000; // 24h for completed days (effectively immutable)
const ARCHIVE_DAY_TTL_TODAY = 60 * 1000;          // 60s for the current day

const archiveDayCache = new Map<string, CacheEntry<Map<string, Record<string, string>[]>>>();

/** YYYY-MM-DD → YYYYMMDD */
function compactDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function isoIsToday(isoDate: string): boolean {
  const todayIso = new Date().toISOString().slice(0, 10);
  return isoDate === todayIso;
}

export type ArchiveReport = "DISPATCHSCADA" | "DISPATCHIS";

const ARCHIVE_PATHS: Record<ArchiveReport, string> = {
  DISPATCHSCADA: "/Reports/Archive/Dispatch_SCADA/",
  DISPATCHIS:    "/Reports/Archive/DispatchIS_Reports/",
};

/**
 * Fetch one day's worth of archived data for a given report.
 * isoDate is YYYY-MM-DD. Returns the same table-map shape as fetchLatest entries.
 *
 * `tables` optionally filters the output to only the named compound table keys
 * (e.g. "DISPATCH_PRICE"). This is critical for memory — DispatchIS contains ~15
 * tables (REGIONSUM, INTERCONNECTORRES, CASE_SOLUTION, etc.) and dropping the
 * unneeded ones at parse time reduces per-day memory by ~90%.
 *
 * Past days are cached for 24h; today for 60s (archive publishes ~01:01 next day
 * but we still want a short TTL to pick up fresh publishes).
 */
export async function fetchArchiveDay(
  report: ArchiveReport,
  isoDate: string,
  tables?: ReadonlySet<string>,
): Promise<Map<string, Record<string, string>[]>> {
  const tablesKey = tables ? [...tables].sort().join(",") : "*";
  const key = `${report}:${isoDate}:${tablesKey}`;
  const cached = archiveDayCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.data;

  return dedup(`archiveDay:${key}`, async () => {
    const compact = compactDate(isoDate);
    const url = `${BASE}${ARCHIVE_PATHS[report]}PUBLIC_${report}_${compact}.zip`;

    const res = await fetchWithRetry(url);
    const buf = await res.arrayBuffer();
    const outerZip = await JSZip.loadAsync(buf);

    const merged = new Map<string, Record<string, string>[]>();

    // Collect inner zip entries in filename order (AEMO names are chronological)
    const innerEntries = Object.keys(outerZip.files)
      .filter((n) => n.toLowerCase().endsWith(".zip"))
      .sort();

    for (const entryName of innerEntries) {
      const innerBuf = await outerZip.files[entryName].async("uint8array");
      const innerZip = await JSZip.loadAsync(innerBuf);

      let csvText = "";
      for (const name of Object.keys(innerZip.files)) {
        if (name.toLowerCase().endsWith(".csv")) {
          csvText = await innerZip.files[name].async("text");
          break;
        }
      }
      if (!csvText) continue;

      const parsed = parseNEMWebCSV(csvText);
      for (const [table, rows] of parsed) {
        if (tables && !tables.has(table)) continue;
        const existing = merged.get(table);
        if (existing) existing.push(...rows);
        else merged.set(table, rows.slice());
      }
    }

    const ttl = isoIsToday(isoDate) ? ARCHIVE_DAY_TTL_TODAY : ARCHIVE_DAY_TTL_PAST;
    archiveDayCache.set(key, { data: merged, expiry: Date.now() + ttl });
    return merged;
  });
}

/** Clear archive day cache — used for forced refresh */
export function clearArchiveCache(): void {
  archiveDayCache.clear();
}
