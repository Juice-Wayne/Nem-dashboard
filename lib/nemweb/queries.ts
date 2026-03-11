import { fetchLatest, normaliseDate, SOURCES } from "./fetcher";

// --- Result cache ---

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const resultCache = new Map<string, CacheEntry<unknown>>();
const RESULT_TTL = 5_000;  // 5s — aggressive to pick up new data immediately

function getCached<T>(key: string): T | null {
  const c = resultCache.get(key);
  if (c && c.expiry > Date.now()) return c.data as T;
  return null;
}

function setCache<T>(key: string, data: T): T {
  resultCache.set(key, { data, expiry: Date.now() + RESULT_TTL });
  return data;
}

/** Clear all result caches — used for forced refresh */
export function clearResultCache(): void {
  resultCache.clear();
}

// --- Helpers ---

function num(v: string | undefined): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function numOrNull(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** Extract rows from a parsed NEMWeb table map, trying multiple table key patterns */
function getTable(
  tables: Map<string, Record<string, string>[]>,
  ...candidates: string[]
): Record<string, string>[] {
  for (const name of candidates) {
    const upper = name.toUpperCase();
    for (const [key, rows] of tables) {
      if (key.includes(upper)) return rows;
    }
  }
  return [];
}

// =======================================================================
// Price changes — P5MIN
// =======================================================================

export async function getP5MinPriceChanges(): Promise<
  { INTERVAL_DATETIME: string; REGIONID: string; CURRENT_RRP: number; PREVIOUS_RRP: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinPriceChanges>>("p5price");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.p5min);
  const curRows = getTable(current, "REGIONSOLUTION");
  const prevRows = getTable(previous, "REGIONSOLUTION");

  // Build lookup: interval+region → RRP from previous run
  const prevMap = new Map<string, number>();
  for (const r of prevRows) {
    prevMap.set(`${r.INTERVAL_DATETIME}|${r.REGIONID}`, num(r.RRP));
  }

  const results: { INTERVAL_DATETIME: string; REGIONID: string; CURRENT_RRP: number; PREVIOUS_RRP: number; DELTA: number }[] = [];
  for (const r of curRows) {
    const key = `${r.INTERVAL_DATETIME}|${r.REGIONID}`;
    const prev = prevMap.get(key);
    if (prev === undefined) continue;
    const cur = num(r.RRP);
    results.push({
      INTERVAL_DATETIME: normaliseDate(r.INTERVAL_DATETIME),
      REGIONID: r.REGIONID,
      CURRENT_RRP: cur,
      PREVIOUS_RRP: prev,
      DELTA: cur - prev,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("p5price", results);
}

// =======================================================================
// Price changes — 30min Predispatch
// =======================================================================

export async function getPredispatchPriceChanges(): Promise<
  { DATETIME: string; REGIONID: string; CURRENT_RRP: number; PREVIOUS_RRP: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getPredispatchPriceChanges>>("pdprice");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.predispatch);
  const curRows = getTable(current, "REGION_PRICES", "REGIONPRICE", "PRICE");
  const prevRows = getTable(previous, "REGION_PRICES", "REGIONPRICE", "PRICE");

  const prevMap = new Map<string, number>();
  for (const r of prevRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    prevMap.set(`${dt}|${r.REGIONID}`, num(r.RRP));
  }

  const results: { DATETIME: string; REGIONID: string; CURRENT_RRP: number; PREVIOUS_RRP: number; DELTA: number }[] = [];
  for (const r of curRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    const key = `${dt}|${r.REGIONID}`;
    const prev = prevMap.get(key);
    if (prev === undefined) continue;
    const cur = num(r.RRP);
    results.push({
      DATETIME: normaliseDate(dt),
      REGIONID: r.REGIONID,
      CURRENT_RRP: cur,
      PREVIOUS_RRP: prev,
      DELTA: cur - prev,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("pdprice", results);
}

// =======================================================================
// Demand changes — P5MIN
// =======================================================================

export async function getP5MinDemandChanges(): Promise<
  { INTERVAL_DATETIME: string; REGIONID: string; CURRENT_TOTALDEMAND: number; PREVIOUS_TOTALDEMAND: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinDemandChanges>>("p5demand");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.p5min);
  const curRows = getTable(current, "REGIONSOLUTION");
  const prevRows = getTable(previous, "REGIONSOLUTION");

  const prevMap = new Map<string, number>();
  for (const r of prevRows) {
    prevMap.set(`${r.INTERVAL_DATETIME}|${r.REGIONID}`, num(r.TOTALDEMAND));
  }

  const results: { INTERVAL_DATETIME: string; REGIONID: string; CURRENT_TOTALDEMAND: number; PREVIOUS_TOTALDEMAND: number; DELTA: number }[] = [];
  for (const r of curRows) {
    const key = `${r.INTERVAL_DATETIME}|${r.REGIONID}`;
    const prev = prevMap.get(key);
    if (prev === undefined) continue;
    const cur = num(r.TOTALDEMAND);
    results.push({
      INTERVAL_DATETIME: normaliseDate(r.INTERVAL_DATETIME),
      REGIONID: r.REGIONID,
      CURRENT_TOTALDEMAND: cur,
      PREVIOUS_TOTALDEMAND: prev,
      DELTA: cur - prev,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("p5demand", results);
}

// =======================================================================
// Demand changes — 30min Predispatch
// =======================================================================

export async function getPredispatchDemandChanges(): Promise<
  { DATETIME: string; REGIONID: string; CURRENT_TOTALDEMAND: number; PREVIOUS_TOTALDEMAND: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getPredispatchDemandChanges>>("pddemand");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.predispatch);
  const curRows = getTable(current, "REGION_SOLUTION", "REGIONSOLUTION");
  const prevRows = getTable(previous, "REGION_SOLUTION", "REGIONSOLUTION");

  const prevMap = new Map<string, number>();
  for (const r of prevRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    prevMap.set(`${dt}|${r.REGIONID}`, num(r.TOTALDEMAND));
  }

  const results: { DATETIME: string; REGIONID: string; CURRENT_TOTALDEMAND: number; PREVIOUS_TOTALDEMAND: number; DELTA: number }[] = [];
  for (const r of curRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    const key = `${dt}|${r.REGIONID}`;
    const prev = prevMap.get(key);
    if (prev === undefined) continue;
    const cur = num(r.TOTALDEMAND);
    results.push({
      DATETIME: normaliseDate(dt),
      REGIONID: r.REGIONID,
      CURRENT_TOTALDEMAND: cur,
      PREVIOUS_TOTALDEMAND: prev,
      DELTA: cur - prev,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("pddemand", results);
}

// =======================================================================
// Interconnector changes — P5MIN
// =======================================================================

export async function getP5MinInterconnectorChanges(): Promise<
  { INTERVAL_DATETIME: string; INTERCONNECTORID: string; CURRENT_MWFLOW: number; PREVIOUS_MWFLOW: number; FLOW_DELTA: number; CURRENT_IMPORTLIMIT: number | null; PREVIOUS_IMPORTLIMIT: number | null; IMPORT_DELTA: number | null; CURRENT_EXPORTLIMIT: number | null; PREVIOUS_EXPORTLIMIT: number | null; EXPORT_DELTA: number | null }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinInterconnectorChanges>>("p5ic");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.p5min);
  const curRows = getTable(current, "INTERCONNECTORSOLN");
  const prevRows = getTable(previous, "INTERCONNECTORSOLN");

  const prevMap = new Map<string, Record<string, string>>();
  for (const r of prevRows) {
    prevMap.set(`${r.INTERVAL_DATETIME}|${r.INTERCONNECTORID}`, r);
  }

  const results: ReturnType<typeof getP5MinInterconnectorChanges> extends Promise<infer R> ? R : never = [];
  for (const r of curRows) {
    const key = `${r.INTERVAL_DATETIME}|${r.INTERCONNECTORID}`;
    const prev = prevMap.get(key);
    if (!prev) continue;

    const cFlow = num(r.MWFLOW);
    const pFlow = num(prev.MWFLOW);
    const cImp = numOrNull(r.IMPORTLIMIT);
    const pImp = numOrNull(prev.IMPORTLIMIT);
    const cExp = numOrNull(r.EXPORTLIMIT);
    const pExp = numOrNull(prev.EXPORTLIMIT);

    results.push({
      INTERVAL_DATETIME: normaliseDate(r.INTERVAL_DATETIME),
      INTERCONNECTORID: r.INTERCONNECTORID,
      CURRENT_MWFLOW: cFlow,
      PREVIOUS_MWFLOW: pFlow,
      FLOW_DELTA: cFlow - pFlow,
      CURRENT_IMPORTLIMIT: cImp,
      PREVIOUS_IMPORTLIMIT: pImp,
      IMPORT_DELTA: cImp !== null && pImp !== null ? cImp - pImp : null,
      CURRENT_EXPORTLIMIT: cExp,
      PREVIOUS_EXPORTLIMIT: pExp,
      EXPORT_DELTA: cExp !== null && pExp !== null ? cExp - pExp : null,
    });
  }

  results.sort((a, b) => Math.abs(b.FLOW_DELTA) - Math.abs(a.FLOW_DELTA));
  return setCache("p5ic", results);
}

// =======================================================================
// Interconnector changes — 30min Predispatch
// =======================================================================

export async function getPredispatchInterconnectorChanges(): Promise<
  { DATETIME: string; INTERCONNECTORID: string; CURRENT_MWFLOW: number; PREVIOUS_MWFLOW: number; FLOW_DELTA: number; CURRENT_IMPORTLIMIT: number | null; PREVIOUS_IMPORTLIMIT: number | null; IMPORT_DELTA: number | null; CURRENT_EXPORTLIMIT: number | null; PREVIOUS_EXPORTLIMIT: number | null; EXPORT_DELTA: number | null }[]
> {
  const cached = getCached<ReturnType<typeof getPredispatchInterconnectorChanges>>("pdic");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.predispatch);
  const curRows = getTable(current, "INTERCONNECTOR_SOLN", "INTERCONNECTORSOLN");
  const prevRows = getTable(previous, "INTERCONNECTOR_SOLN", "INTERCONNECTORSOLN");

  const prevMap = new Map<string, Record<string, string>>();
  for (const r of prevRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    prevMap.set(`${dt}|${r.INTERCONNECTORID}`, r);
  }

  const results: ReturnType<typeof getPredispatchInterconnectorChanges> extends Promise<infer R> ? R : never = [];
  for (const r of curRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    const key = `${dt}|${r.INTERCONNECTORID}`;
    const prev = prevMap.get(key);
    if (!prev) continue;

    const cFlow = num(r.MWFLOW);
    const pFlow = num(prev.MWFLOW);
    const cImp = numOrNull(r.IMPORTLIMIT);
    const pImp = numOrNull(prev.IMPORTLIMIT);
    const cExp = numOrNull(r.EXPORTLIMIT);
    const pExp = numOrNull(prev.EXPORTLIMIT);

    results.push({
      DATETIME: normaliseDate(dt),
      INTERCONNECTORID: r.INTERCONNECTORID,
      CURRENT_MWFLOW: cFlow,
      PREVIOUS_MWFLOW: pFlow,
      FLOW_DELTA: cFlow - pFlow,
      CURRENT_IMPORTLIMIT: cImp,
      PREVIOUS_IMPORTLIMIT: pImp,
      IMPORT_DELTA: cImp !== null && pImp !== null ? cImp - pImp : null,
      CURRENT_EXPORTLIMIT: cExp,
      PREVIOUS_EXPORTLIMIT: pExp,
      EXPORT_DELTA: cExp !== null && pExp !== null ? cExp - pExp : null,
    });
  }

  results.sort((a, b) => Math.abs(b.FLOW_DELTA) - Math.abs(a.FLOW_DELTA));
  return setCache("pdic", results);
}

// =======================================================================
// Scenario demand mappings (from AEMO MMSDM reference data)
// Maps RRPEEP scenario number → primary region + MW offset
// =======================================================================

const PD_SCENARIOS: Record<number, { region: string; deltaMW: number }> = {
  1:  { region: "NSW1", deltaMW: 100 },
  2:  { region: "NSW1", deltaMW: -100 },
  3:  { region: "NSW1", deltaMW: 200 },
  4:  { region: "NSW1", deltaMW: -200 },
  5:  { region: "NSW1", deltaMW: 500 },
  6:  { region: "NSW1", deltaMW: -500 },
  7:  { region: "NSW1", deltaMW: 1000 },
  8:  { region: "VIC1", deltaMW: 100 },
  9:  { region: "VIC1", deltaMW: -100 },
  10: { region: "VIC1", deltaMW: 200 },
  11: { region: "VIC1", deltaMW: -200 },
  12: { region: "VIC1", deltaMW: 500 },
  13: { region: "VIC1", deltaMW: -500 },
  14: { region: "VIC1", deltaMW: 1000 },
  15: { region: "SA1",  deltaMW: 50 },
  16: { region: "SA1",  deltaMW: -50 },
  17: { region: "SA1",  deltaMW: 100 },
  18: { region: "SA1",  deltaMW: -100 },
  19: { region: "SA1",  deltaMW: 200 },
  20: { region: "SA1",  deltaMW: -200 },
  25: { region: "NEM",  deltaMW: 450 },
  26: { region: "NEM",  deltaMW: -450 },
  27: { region: "NEM",  deltaMW: 900 },
  28: { region: "NEM",  deltaMW: -900 },
  29: { region: "QLD1", deltaMW: 100 },
  30: { region: "QLD1", deltaMW: -100 },
  31: { region: "QLD1", deltaMW: 200 },
  32: { region: "QLD1", deltaMW: -200 },
  33: { region: "QLD1", deltaMW: 500 },
  34: { region: "QLD1", deltaMW: -500 },
  35: { region: "QLD1", deltaMW: 1000 },
  36: { region: "TAS1", deltaMW: 50 },
  37: { region: "TAS1", deltaMW: -50 },
  38: { region: "TAS1", deltaMW: 100 },
  39: { region: "TAS1", deltaMW: -100 },
  40: { region: "TAS1", deltaMW: 150 },
  41: { region: "TAS1", deltaMW: -150 },
  42: { region: "TAS1", deltaMW: 300 },
  43: { region: "SA1",  deltaMW: 500 },
};

// =======================================================================
// Sensitivity changes — P5MIN (NOT available on NEMWeb)
// =======================================================================

export async function getP5MinSensitivityChanges(): Promise<
  { INTERVAL_DATETIME: string; REGIONID: string; SCENARIO: string; DELTAMW: number | null; OFFSET_REGIONID: string | null; CURRENT_RRPSCENARIO: number; PREVIOUS_RRPSCENARIO: number; DELTA: number }[]
> {
  // P5MIN sensitivity data is not published on NEMWeb Current reports
  return [];
}

// =======================================================================
// Sensitivity changes — 30min Predispatch
// =======================================================================

export async function getPredispatchSensitivityChanges(): Promise<
  { DATETIME: string; REGIONID: string; SCENARIO: string; DELTAMW: number | null; OFFSET_REGIONID: string | null; CURRENT_RRPSCENARIO: number; PREVIOUS_RRPSCENARIO: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getPredispatchSensitivityChanges>>("pdsens");
  if (cached) return cached;

  const [current, previous] = await fetchLatest(SOURCES.sensitivities);
  const curRows = getTable(current, "PRICESENSITIVITIES", "PRICE_SENSITIVITY");
  const prevRows = getTable(previous, "PRICESENSITIVITIES", "PRICE_SENSITIVITY");

  // Build previous lookup: datetime+region+scenario → RRP value
  // Unpivot RRPEEP1..RRPEEP43 columns
  const prevMap = new Map<string, number>();
  for (const r of prevRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    for (let i = 1; i <= 43; i++) {
      const col = `RRPEEP${i}`;
      const val = r[col];
      if (val !== undefined && val !== "") {
        prevMap.set(`${dt}|${r.REGIONID}|RRPEEP${i}`, num(val));
      }
    }
  }

  const results: { DATETIME: string; REGIONID: string; SCENARIO: string; DELTAMW: number | null; OFFSET_REGIONID: string | null; CURRENT_RRPSCENARIO: number; PREVIOUS_RRPSCENARIO: number; DELTA: number }[] = [];

  for (const r of curRows) {
    const dt = r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "";
    for (let i = 1; i <= 43; i++) {
      const col = `RRPEEP${i}`;
      const curVal = r[col];
      if (curVal === undefined || curVal === "") continue;
      const curNum = num(curVal);
      const prevNum = prevMap.get(`${dt}|${r.REGIONID}|${col}`);
      if (prevNum === undefined) continue;
      if (curNum === prevNum) continue;

      const scenario = PD_SCENARIOS[i];
      results.push({
        DATETIME: normaliseDate(dt),
        REGIONID: r.REGIONID,
        SCENARIO: col,
        DELTAMW: scenario?.deltaMW ?? null,
        OFFSET_REGIONID: scenario?.region ?? null,
        CURRENT_RRPSCENARIO: curNum,
        PREVIOUS_RRPSCENARIO: prevNum,
        DELTA: curNum - prevNum,
      });
    }
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("pdsens", results);
}

// =======================================================================
// Actuals vs 5PD — Prices
// =======================================================================

export async function getP5MinVsActualPrices(): Promise<
  { INTERVAL_DATETIME: string; REGIONID: string; FORECAST_RRP: number; ACTUAL_RRP: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinVsActualPrices>>("vsPrice");
  if (cached) return cached;

  // Use the same data as the 5PD changes table — "Current" is the latest forecast
  // for each interval, which we compare against actuals when they arrive
  const [p5changes, [dispData]] = await Promise.all([
    getP5MinPriceChanges(),
    fetchLatest(SOURCES.dispatch),
  ]);

  // Build forecast lookup from the 5PD "Current" values (CURRENT_RRP)
  const forecastMap = new Map<string, number>();
  for (const row of p5changes) {
    forecastMap.set(`${row.INTERVAL_DATETIME}|${row.REGIONID}`, row.CURRENT_RRP);
  }

  const actual = getTable(dispData, "DISPATCH_PRICE");

  // Build actual lookup: settlementdate+region → RRP
  const actualMap = new Map<string, number>();
  for (const r of actual) {
    if (r.INTERVENTION && r.INTERVENTION !== "0") continue;
    const dt = normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || "");
    actualMap.set(`${dt}|${r.REGIONID}`, num(r.RRP));
  }

  const results: { INTERVAL_DATETIME: string; REGIONID: string; FORECAST_RRP: number; ACTUAL_RRP: number; DELTA: number }[] = [];
  for (const [key, fRRP] of forecastMap) {
    const actRRP = actualMap.get(key);
    if (actRRP === undefined) continue;
    const [dt, regionId] = key.split("|");
    results.push({
      INTERVAL_DATETIME: dt,
      REGIONID: regionId,
      FORECAST_RRP: fRRP,
      ACTUAL_RRP: actRRP,
      DELTA: actRRP - fRRP,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("vsPrice", results);
}

// =======================================================================
// Actuals vs 5PD — Demand
// =======================================================================

export async function getP5MinVsActualDemand(): Promise<
  { INTERVAL_DATETIME: string; REGIONID: string; FORECAST_TOTALDEMAND: number; ACTUAL_TOTALDEMAND: number; DELTA: number }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinVsActualDemand>>("vsDemand");
  if (cached) return cached;

  // Use the same data as the 5PD changes table — "Current" is the latest forecast
  // for each interval, which we compare against actuals when they arrive
  const [p5changes, [dispData]] = await Promise.all([
    getP5MinDemandChanges(),
    fetchLatest(SOURCES.dispatch),
  ]);

  // Build forecast lookup from the 5PD "Current" values (CURRENT_TOTALDEMAND)
  const forecastMap = new Map<string, number>();
  for (const row of p5changes) {
    forecastMap.set(`${row.INTERVAL_DATETIME}|${row.REGIONID}`, row.CURRENT_TOTALDEMAND);
  }

  const actual = getTable(dispData, "REGIONSUM", "DISPATCH_REGIONSUM");

  const actualMap = new Map<string, number>();
  for (const r of actual) {
    if (r.INTERVENTION && r.INTERVENTION !== "0") continue;
    const dt = normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || "");
    actualMap.set(`${dt}|${r.REGIONID}`, num(r.TOTALDEMAND));
  }

  const results: { INTERVAL_DATETIME: string; REGIONID: string; FORECAST_TOTALDEMAND: number; ACTUAL_TOTALDEMAND: number; DELTA: number }[] = [];
  for (const [key, fDem] of forecastMap) {
    const actDem = actualMap.get(key);
    if (actDem === undefined) continue;
    const [dt, regionId] = key.split("|");
    results.push({
      INTERVAL_DATETIME: dt,
      REGIONID: regionId,
      FORECAST_TOTALDEMAND: fDem,
      ACTUAL_TOTALDEMAND: actDem,
      DELTA: actDem - fDem,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return setCache("vsDemand", results);
}

// =======================================================================
// Actuals vs 5PD — Interconnectors
// =======================================================================

export async function getP5MinVsActualInterconnectors(): Promise<
  { INTERVAL_DATETIME: string; INTERCONNECTORID: string; FORECAST_MWFLOW: number; ACTUAL_MWFLOW: number; FLOW_DELTA: number; FORECAST_IMPORTLIMIT: number | null; ACTUAL_IMPORTLIMIT: number | null; IMPORT_DELTA: number | null; FORECAST_EXPORTLIMIT: number | null; ACTUAL_EXPORTLIMIT: number | null; EXPORT_DELTA: number | null }[]
> {
  const cached = getCached<ReturnType<typeof getP5MinVsActualInterconnectors>>("vsIC");
  if (cached) return cached;

  // Use the same data as the 5PD changes table so "5PD Forecast" matches "Current" column
  const [p5changes, [dispData]] = await Promise.all([
    getP5MinInterconnectorChanges(),
    fetchLatest(SOURCES.dispatch),
  ]);

  // Build forecast lookup from the 5PD "Current" values
  const forecastMap = new Map<string, { MWFLOW: number; IMPORTLIMIT: number | null; EXPORTLIMIT: number | null }>();
  for (const row of p5changes) {
    forecastMap.set(`${row.INTERVAL_DATETIME}|${row.INTERCONNECTORID}`, {
      MWFLOW: row.CURRENT_MWFLOW,
      IMPORTLIMIT: row.CURRENT_IMPORTLIMIT,
      EXPORTLIMIT: row.CURRENT_EXPORTLIMIT,
    });
  }

  const actual = getTable(dispData, "INTERCONNECTORRES", "DISPATCH_INTERCONNECTORRES");

  const actualMap = new Map<string, Record<string, string>>();
  for (const r of actual) {
    const dt = normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || "");
    actualMap.set(`${dt}|${r.INTERCONNECTORID}`, r);
  }

  const results: ReturnType<typeof getP5MinVsActualInterconnectors> extends Promise<infer R> ? R : never = [];
  for (const [key, f] of forecastMap) {
    const act = actualMap.get(key);
    if (!act) continue;

    const aFlow = num(act.MWFLOW);
    const aImp = numOrNull(act.IMPORTLIMIT);
    const aExp = numOrNull(act.EXPORTLIMIT);

    const [dt, icId] = key.split("|");
    results.push({
      INTERVAL_DATETIME: dt,
      INTERCONNECTORID: icId,
      FORECAST_MWFLOW: f.MWFLOW,
      ACTUAL_MWFLOW: aFlow,
      FLOW_DELTA: aFlow - f.MWFLOW,
      FORECAST_IMPORTLIMIT: f.IMPORTLIMIT,
      ACTUAL_IMPORTLIMIT: aImp,
      IMPORT_DELTA: aImp !== null && f.IMPORTLIMIT !== null ? aImp - f.IMPORTLIMIT : null,
      FORECAST_EXPORTLIMIT: f.EXPORTLIMIT,
      ACTUAL_EXPORTLIMIT: aExp,
      EXPORT_DELTA: aExp !== null && f.EXPORTLIMIT !== null ? aExp - f.EXPORTLIMIT : null,
    });
  }

  results.sort((a, b) => Math.abs(b.FLOW_DELTA) - Math.abs(a.FLOW_DELTA));
  return setCache("vsIC", results);
}
