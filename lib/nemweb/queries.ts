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

// =======================================================================
// Analytics — Generation Stack (DISPATCH_UNIT_SCADA)
// =======================================================================

export async function getGenerationStack(): Promise<
  { DUID: string; SCADAVALUE: number }[]
> {
  const cached = getCached<ReturnType<typeof getGenerationStack>>("genStack");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.dispatchScada);
  const rows = getTable(data, "DISPATCH_UNIT_SCADA", "UNIT_SCADA");

  const results = rows.map((r) => ({
    DUID: r.DUID,
    SCADAVALUE: num(r.SCADAVALUE),
  }));

  results.sort((a, b) => b.SCADAVALUE - a.SCADAVALUE);
  return setCache("genStack", results);
}

// =======================================================================
// Analytics — Binding Constraints
// =======================================================================

export async function getBindingConstraints(): Promise<
  { CONSTRAINTID: string; INTERVAL_DATETIME: string; RHS: number; MARGINALVALUE: number; VIOLATIONDEGREE: number }[]
> {
  const cached = getCached<ReturnType<typeof getBindingConstraints>>("constraints");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.dispatch);
  const rows = getTable(data, "DISPATCH_CONSTRAINT", "CONSTRAINT");

  const results: { CONSTRAINTID: string; INTERVAL_DATETIME: string; RHS: number; MARGINALVALUE: number; VIOLATIONDEGREE: number }[] = [];
  for (const r of rows) {
    const mv = num(r.MARGINALVALUE);
    if (mv === 0) continue; // only binding constraints
    results.push({
      CONSTRAINTID: r.CONSTRAINTID || r.GENCONID || "",
      INTERVAL_DATETIME: normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || ""),
      RHS: num(r.RHS),
      MARGINALVALUE: mv,
      VIOLATIONDEGREE: num(r.VIOLATIONDEGREE),
    });
  }

  results.sort((a, b) => Math.abs(b.MARGINALVALUE) - Math.abs(a.MARGINALVALUE));
  return setCache("constraints", results);
}

// =======================================================================
// Analytics — FCAS Prices
// =======================================================================

export async function getFcasPrices(): Promise<
  { REGIONID: string; INTERVAL_DATETIME: string; RAISE6SECRRP: number; RAISE60SECRRP: number; RAISE5MINRRP: number; RAISEREGRRP: number; LOWER6SECRRP: number; LOWER60SECRRP: number; LOWER5MINRRP: number; LOWERREGRRP: number }[]
> {
  const cached = getCached<ReturnType<typeof getFcasPrices>>("fcas");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.dispatch);
  const rows = getTable(data, "DISPATCH_PRICE", "PRICE");

  const results = rows
    .filter((r) => !r.INTERVENTION || r.INTERVENTION === "0")
    .map((r) => ({
      REGIONID: r.REGIONID,
      INTERVAL_DATETIME: normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || ""),
      RAISE6SECRRP: num(r.RAISE6SECRRP),
      RAISE60SECRRP: num(r.RAISE60SECRRP),
      RAISE5MINRRP: num(r.RAISE5MINRRP),
      RAISEREGRRP: num(r.RAISEREGRRP),
      LOWER6SECRRP: num(r.LOWER6SECRRP),
      LOWER60SECRRP: num(r.LOWER60SECRRP),
      LOWER5MINRRP: num(r.LOWER5MINRRP),
      LOWERREGRRP: num(r.LOWERREGRRP),
    }));

  return setCache("fcas", results);
}

// =======================================================================
// Analytics — Bid Stack (Bidmove Complete)
// =======================================================================

export async function getBidStack(): Promise<
  { DUID: string; BIDTYPE: string; REBIDEXPLANATION: string; PRICEBAND1: number; PRICEBAND2: number; PRICEBAND3: number; PRICEBAND4: number; PRICEBAND5: number; PRICEBAND6: number; PRICEBAND7: number; PRICEBAND8: number; PRICEBAND9: number; PRICEBAND10: number; BANDAVAIL1: number; BANDAVAIL2: number; BANDAVAIL3: number; BANDAVAIL4: number; BANDAVAIL5: number; BANDAVAIL6: number; BANDAVAIL7: number; BANDAVAIL8: number; BANDAVAIL9: number; BANDAVAIL10: number }[]
> {
  const cached = getCached<ReturnType<typeof getBidStack>>("bidstack");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.bidmove);
  const rows = getTable(data, "BIDMOVE_COMPLETE", "BIDDAYOFFER", "BIDPEROFFER");

  const results = rows.map((r) => ({
    DUID: r.DUID,
    BIDTYPE: r.BIDTYPE || "ENERGY",
    REBIDEXPLANATION: r.REBIDEXPLANATION || "",
    PRICEBAND1: num(r.PRICEBAND1), PRICEBAND2: num(r.PRICEBAND2), PRICEBAND3: num(r.PRICEBAND3),
    PRICEBAND4: num(r.PRICEBAND4), PRICEBAND5: num(r.PRICEBAND5), PRICEBAND6: num(r.PRICEBAND6),
    PRICEBAND7: num(r.PRICEBAND7), PRICEBAND8: num(r.PRICEBAND8), PRICEBAND9: num(r.PRICEBAND9),
    PRICEBAND10: num(r.PRICEBAND10),
    BANDAVAIL1: num(r.BANDAVAIL1), BANDAVAIL2: num(r.BANDAVAIL2), BANDAVAIL3: num(r.BANDAVAIL3),
    BANDAVAIL4: num(r.BANDAVAIL4), BANDAVAIL5: num(r.BANDAVAIL5), BANDAVAIL6: num(r.BANDAVAIL6),
    BANDAVAIL7: num(r.BANDAVAIL7), BANDAVAIL8: num(r.BANDAVAIL8), BANDAVAIL9: num(r.BANDAVAIL9),
    BANDAVAIL10: num(r.BANDAVAIL10),
  }));

  return setCache("bidstack", results);
}

// =======================================================================
// Analytics — Rooftop PV (Actual + Forecast)
// =======================================================================

export async function getRooftopPV(): Promise<
  { REGIONID: string; INTERVAL_DATETIME: string; ACTUAL_MW: number | null; FORECAST_MW: number | null }[]
> {
  const cached = getCached<ReturnType<typeof getRooftopPV>>("rooftoppv");
  if (cached) return cached;

  const [actualFiles, forecastFiles] = await Promise.all([
    fetchLatest(SOURCES.rooftopPvActual),
    fetchLatest(SOURCES.rooftopPvForecast),
  ]);

  // Merge rows from all actual files (each file typically has one interval)
  const actualRows: Record<string, string>[] = [];
  for (const file of actualFiles) {
    actualRows.push(...getTable(file, "ROOFTOP_PV_ACTUAL", "ROOFTOP_ACTUAL", "ACTUAL"));
  }
  const forecastRows = getTable(forecastFiles[0], "ROOFTOP_PV_FORECAST", "ROOFTOP_FORECAST", "FORECAST", "REGIONFORECAST");

  // Build maps keyed by interval+region
  const actualMap = new Map<string, number>();
  for (const r of actualRows) {
    const dt = normaliseDate(r.INTERVAL_DATETIME || r.SETTLEMENTDATE || "");
    actualMap.set(`${dt}|${r.REGIONID}`, num(r.POWER || r.GENERATION || r.MW || "0"));
  }

  const forecastMap = new Map<string, number>();
  for (const r of forecastRows) {
    const dt = normaliseDate(r.INTERVAL_DATETIME || r.SETTLEMENTDATE || "");
    forecastMap.set(`${dt}|${r.REGIONID}`, num(r.POWER || r.GENERATION || r.POWERMEAN || r.MW || "0"));
  }

  // Merge keys
  const allKeys = new Set([...actualMap.keys(), ...forecastMap.keys()]);
  const results: { REGIONID: string; INTERVAL_DATETIME: string; ACTUAL_MW: number | null; FORECAST_MW: number | null }[] = [];
  for (const key of allKeys) {
    const [dt, regionId] = key.split("|");
    results.push({
      REGIONID: regionId,
      INTERVAL_DATETIME: dt,
      ACTUAL_MW: actualMap.get(key) ?? null,
      FORECAST_MW: forecastMap.get(key) ?? null,
    });
  }

  results.sort((a, b) => a.INTERVAL_DATETIME.localeCompare(b.INTERVAL_DATETIME));
  return setCache("rooftoppv", results);
}

// =======================================================================
// Analytics — Rebid Feed (BIDMOVE_COMPLETE)
// Groups FCAS services into a single entry per DUID+REBIDTIME
// =======================================================================

export interface RebidEntry {
  DUID: string;
  BIDCATEGORY: "ENERGY" | "FCAS";
  FCAS_SERVICES: string[];       // e.g. ["RAISE6SEC","LOWER60SEC"] — empty for ENERGY
  REBIDTIME: string;
  REBIDCATEGORY: string;
  REBIDEXPLANATION: string;
  BANDAVAIL: number[];           // 10 bands (ENERGY only, empty for FCAS)
  PRICEBAND: number[];           // 10 bands (ENERGY only, empty for FCAS)
  TOTALAVAIL: number;
}

export async function getRebidFeed(): Promise<RebidEntry[]> {
  const cached = getCached<RebidEntry[]>("rebidFeed");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.bidmove);
  const rows = getTable(data, "BIDMOVE_COMPLETE", "BIDDAYOFFER", "BIDPEROFFER");

  const energyResults: RebidEntry[] = [];
  // Group FCAS by DUID+REBIDTIME to avoid double-counting
  const fcasGroupMap = new Map<string, RebidEntry>();

  for (const r of rows) {
    const duid = r.DUID || "";
    const bidtype = r.BIDTYPE || "ENERGY";
    const rebidTime = normaliseDate(r.REBIDTIME || r.OFFERDATE || r.SETTLEMENTDATE || "");
    const explanation = r.REBIDEXPLANATION || "";
    const category = r.REBIDCATEGORY || "";

    if (bidtype === "ENERGY") {
      const bandAvail: number[] = [];
      const priceBand: number[] = [];
      let totalAvail = 0;
      for (let i = 1; i <= 10; i++) {
        const avail = num(r[`BANDAVAIL${i}`]);
        bandAvail.push(avail);
        priceBand.push(num(r[`PRICEBAND${i}`]));
        totalAvail += avail;
      }

      energyResults.push({
        DUID: duid,
        BIDCATEGORY: "ENERGY",
        FCAS_SERVICES: [],
        REBIDTIME: rebidTime,
        REBIDCATEGORY: category,
        REBIDEXPLANATION: explanation,
        BANDAVAIL: bandAvail,
        PRICEBAND: priceBand,
        TOTALAVAIL: totalAvail,
      });
    } else {
      // FCAS — group by DUID + REBIDTIME
      const groupKey = `${duid}|${rebidTime}`;
      const existing = fcasGroupMap.get(groupKey);
      if (existing) {
        if (!existing.FCAS_SERVICES.includes(bidtype)) {
          existing.FCAS_SERVICES.push(bidtype);
        }
        // Use the longest explanation if different
        if (explanation.length > existing.REBIDEXPLANATION.length) {
          existing.REBIDEXPLANATION = explanation;
        }
      } else {
        fcasGroupMap.set(groupKey, {
          DUID: duid,
          BIDCATEGORY: "FCAS",
          FCAS_SERVICES: [bidtype],
          REBIDTIME: rebidTime,
          REBIDCATEGORY: category,
          REBIDEXPLANATION: explanation,
          BANDAVAIL: [],
          PRICEBAND: [],
          TOTALAVAIL: 0,
        });
      }
    }
  }

  const results = [...energyResults, ...fcasGroupMap.values()];
  // Sort newest rebid first
  results.sort((a, b) => b.REBIDTIME.localeCompare(a.REBIDTIME));
  return setCache("rebidFeed", results);
}

// =======================================================================
// Analytics — Price Spike Lookback (dynamic range from NEMWeb)
// Each hour = 12 dispatch files. Files are cached after first download.
// =======================================================================

export interface PriceSpikeEntry {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  RRP: number;
  SEVERITY: "extreme" | "high" | "negative";
  BINDING_CONSTRAINTS: { CONSTRAINTID: string; MARGINALVALUE: number }[];
}

export async function getPriceSpikes(hours: number = 3): Promise<PriceSpikeEntry[]> {
  const clampedHours = Math.max(1, Math.min(168, hours));
  const cacheKey = `priceSpikes_${clampedHours}h`;
  const cached = getCached<PriceSpikeEntry[]>(cacheKey);
  if (cached) return cached;

  const fileCount = clampedHours * 12;
  const dispFiles = await fetchLatest({
    path: SOURCES.dispatch.path,
    count: fileCount,
  });

  const constraintMap = new Map<string, { CONSTRAINTID: string; MARGINALVALUE: number }[]>();
  const results: PriceSpikeEntry[] = [];
  const seen = new Set<string>();

  for (const dispData of dispFiles) {
    const priceRows = getTable(dispData, "DISPATCH_PRICE", "PRICE");
    const constraintRows = getTable(dispData, "DISPATCH_CONSTRAINT", "CONSTRAINT");

    for (const r of constraintRows) {
      const mv = num(r.MARGINALVALUE);
      if (mv === 0) continue;
      const dt = normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || "");
      if (!constraintMap.has(dt)) constraintMap.set(dt, []);
      constraintMap.get(dt)!.push({
        CONSTRAINTID: r.CONSTRAINTID || r.GENCONID || "",
        MARGINALVALUE: mv,
      });
    }

    for (const r of priceRows) {
      if (r.INTERVENTION && r.INTERVENTION !== "0") continue;
      const rrp = num(r.RRP);
      const dt = normaliseDate(r.SETTLEMENTDATE || r.INTERVAL_DATETIME || "");
      const dedupeKey = `${dt}|${r.REGIONID}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let severity: PriceSpikeEntry["SEVERITY"] | null = null;
      if (rrp >= 1000) severity = "extreme";
      else if (rrp >= 300) severity = "high";
      else if (rrp <= -30) severity = "negative";

      if (!severity) continue;

      const constraints = [...(constraintMap.get(dt) || [])];
      constraints.sort((a, b) => Math.abs(b.MARGINALVALUE) - Math.abs(a.MARGINALVALUE));

      results.push({
        INTERVAL_DATETIME: dt,
        REGIONID: r.REGIONID,
        RRP: rrp,
        SEVERITY: severity,
        BINDING_CONSTRAINTS: constraints.slice(0, 5),
      });
    }
  }

  results.sort((a, b) => {
    const timeDiff = b.INTERVAL_DATETIME.localeCompare(a.INTERVAL_DATETIME);
    if (timeDiff !== 0) return timeDiff;
    return Math.abs(b.RRP) - Math.abs(a.RRP);
  });

  return setCache(cacheKey, results);
}

// =======================================================================
// Analytics — Reserve Margins (STPASA)
// =======================================================================

export async function getReserveMargins(): Promise<
  { REGIONID: string; INTERVAL_DATETIME: string; DEMAND10: number; DEMAND50: number; SURPLUSRESERVE: number; RESERVECONDITION: number }[]
> {
  const cached = getCached<ReturnType<typeof getReserveMargins>>("reserves");
  if (cached) return cached;

  const [data] = await fetchLatest(SOURCES.stpasa);
  const rows = getTable(data, "STPASA_REGIONSOLUTION", "REGIONSOLUTION");

  const results = rows.map((r) => ({
    REGIONID: r.REGIONID,
    INTERVAL_DATETIME: normaliseDate(r.INTERVAL_DATETIME || r.SETTLEMENTDATE || ""),
    DEMAND10: num(r.DEMAND10),
    DEMAND50: num(r.DEMAND50),
    SURPLUSRESERVE: num(r.SURPLUSRESERVE),
    RESERVECONDITION: num(r.RESERVECONDITION || r.RESERVE_CONDITION || "0"),
  }));

  results.sort((a, b) => a.INTERVAL_DATETIME.localeCompare(b.INTERVAL_DATETIME));
  return setCache("reserves", results);
}

// =======================================================================
// Analytics — BR Start Cost Analysis
// Models Braemar-style OCGT start economics using P5MIN 5-minute prices.
// Per-interval margin: MW × (price − heatRate × gasCost) / 12
// Running balance starts at −startCost; recovered when balance > 0.
// =======================================================================

export interface StartCostConfig {
  gasCostGJ: number;       // $/GJ delivered gas price
  startCost: number;       // $ fixed cost per start
  loadMW: number;          // MW full load output
  heatRate: number;        // GJ/MWh at full load
  rampRateMWMin: number;   // MW/min ramp rate
}

export interface StartInterval {
  time: string;
  rrp: number;
  mw: number;
  gasCostInterval: number; // gas cost for this 5-min interval
  revenue: number;         // price × MW / 12
  margin: number;          // revenue − gasCost for this interval
  cumBalance: number;      // running balance (starts at −startCost)
}

export interface StartAnalysis {
  startTime: string;
  intervals: StartInterval[];
  recoveryTime: string | null;  // time when cumBalance first > 0
  recoveryMinutes: number | null;
  finalBalance: number;
  peakBalance: number;
  optimalStopTime: string | null; // time to turn off for max profit
  optimalRunMinutes: number | null;
  optimalProfit: number;          // max cumBalance achieved
}

export interface StartCostResult {
  config: StartCostConfig;
  regionId: string;
  srmc: number;              // gasCost × heatRate at full load
  allPrices: { time: string; rrp: number }[];
  analyses: StartAnalysis[]; // one per candidate start time
  bestStart: StartAnalysis | null;
  sensScenario?: number;     // RRPEEP scenario number if using sensitivity prices
  sensLabel?: string;        // human-readable label for the scenario
}

// QLD-relevant sensitivity scenarios for BR start analysis
export const QLD_SENS_SCENARIOS: { rrpeep: number; label: string }[] = [
  { rrpeep: 29, label: "QLD +100 MW" },
  { rrpeep: 30, label: "QLD -100 MW" },
  { rrpeep: 31, label: "QLD +200 MW" },
  { rrpeep: 32, label: "QLD -200 MW" },
  { rrpeep: 33, label: "QLD +500 MW" },
  { rrpeep: 34, label: "QLD -500 MW" },
];

export const DEFAULT_START_COST_CONFIG: StartCostConfig = {
  gasCostGJ: 11.5,
  startCost: 35000,
  loadMW: 170,
  heatRate: 10.4,
  rampRateMWMin: 11,
};

export async function getStartCostAnalysis(
  regionId: string = "QLD1",
  config: StartCostConfig = DEFAULT_START_COST_CONFIG,
  tradingDay: "today" | "d+1" = "today",
  sensScenario?: number, // RRPEEP scenario number (1-43) — uses sensitivity price instead of base RRP for 30-min PD
): Promise<StartCostResult> {
  // Fetch P5MIN + PD, and optionally sensitivities
  const fetches: [Promise<Map<string, Record<string, string>[]>[]>, Promise<Map<string, Record<string, string>[]>[]>, Promise<Map<string, Record<string, string>[]>[]>?] = [
    fetchLatest(SOURCES.p5min),
    fetchLatest(SOURCES.predispatch),
  ];
  if (sensScenario) {
    fetches.push(fetchLatest(SOURCES.sensitivities));
  }
  const results = await Promise.all(fetches.filter(Boolean) as Promise<Map<string, Record<string, string>[]>[]>[]);
  const [p5Current] = results[0];
  const [pdCurrent] = results[1];
  const sensData = sensScenario && results[2] ? results[2][0] : null;

  // P5MIN prices — 5-minute granularity
  const p5Rows = getTable(p5Current, "REGIONSOLUTION");
  const p5Prices: { time: string; rrp: number; durationMin: number }[] = [];
  for (const r of p5Rows) {
    if (r.REGIONID !== regionId) continue;
    const dt = normaliseDate(r.INTERVAL_DATETIME || r.DATETIME || "");
    p5Prices.push({ time: dt, rrp: num(r.RRP), durationMin: 5 });
  }
  p5Prices.sort((a, b) => a.time.localeCompare(b.time));

  // PD prices — 30-minute granularity
  // When a sensitivity scenario is selected, use the RRPEEP price instead of base RRP
  const pdPrices: { time: string; rrp: number; durationMin: number }[] = [];
  if (sensScenario && sensData) {
    const sensRows = getTable(sensData, "PRICESENSITIVITIES", "PRICE_SENSITIVITY");
    const col = `RRPEEP${sensScenario}`;
    for (const r of sensRows) {
      if (r.REGIONID !== regionId) continue;
      const val = r[col];
      if (val === undefined || val === "") continue;
      const dt = normaliseDate(r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "");
      pdPrices.push({ time: dt, rrp: num(val), durationMin: 30 });
    }
  } else {
    const pdRows = getTable(pdCurrent, "REGION_PRICES", "REGIONPRICE", "PRICE");
    for (const r of pdRows) {
      if (r.REGIONID !== regionId) continue;
      const dt = normaliseDate(r.DATETIME || r.PERIODID || r.INTERVAL_DATETIME || "");
      pdPrices.push({ time: dt, rrp: num(r.RRP), durationMin: 30 });
    }
  }
  pdPrices.sort((a, b) => a.time.localeCompare(b.time));

  // Blend: use P5MIN where available, then PD for the rest
  const p5End = p5Prices.length > 0 ? p5Prices[p5Prices.length - 1].time : "";
  const allPrices: { time: string; rrp: number; durationMin: number }[] = [...p5Prices];
  for (const p of pdPrices) {
    if (p.time > p5End) allPrices.push(p);
  }
  allPrices.sort((a, b) => a.time.localeCompare(b.time));

  // Filter to NEM trading day (04:00 AEST to 04:00 AEST next day)
  // AEMO timestamps are in AEST — compare as strings, no TZ conversion
  const now = new Date();
  const aestMs = now.getTime() + (10 * 60 + now.getTimezoneOffset()) * 60000;
  const aestNow = new Date(aestMs);
  // Trading day base: if before 04:00 AEST, trading day started yesterday
  let dayOffset = 0;
  if (aestNow.getHours() < 4) dayOffset = -1;
  if (tradingDay === "d+1") dayOffset += 1;

  const pad = (n: number) => String(n).padStart(2, "0");
  const base = new Date(aestMs + dayOffset * 86400000);
  const tdStart = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T04:00:00`;
  const end = new Date(aestMs + (dayOffset + 1) * 86400000);
  const tdEnd = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T04:00:00`;

  const prices = allPrices.filter((p) => p.time >= tdStart && p.time < tdEnd);

  const srmc = config.gasCostGJ * config.heatRate;

  // Build ramp MW schedule from ramp rate (MW/min)
  // Each minute adds rampRateMWMin to output until loadMW reached
  const rampRate = config.rampRateMWMin;
  const rampMinutes = Math.ceil(config.loadMW / rampRate);

  // Compute MW output at each minute during ramp
  function mwAtMinute(minFromStart: number): number {
    return Math.min(rampRate * minFromStart, config.loadMW);
  }

  // Average MW over an interval starting at minuteOffset from start
  function avgMWForInterval(minuteOffset: number, durationMin: number): number {
    let sum = 0;
    for (let m = 0; m < durationMin; m++) {
      sum += mwAtMinute(minuteOffset + m + 1); // +1: end of each minute
    }
    return sum / durationMin;
  }

  function analyseStart(startIdx: number): StartAnalysis {
    const intervals: StartInterval[] = [];
    let cumBalance = -config.startCost;
    let minuteOffset = 0;

    for (let i = startIdx; i < prices.length; i++) {
      const p = prices[i];
      const dur = p.durationMin;
      const hrs = dur / 60;

      // During ramp, use average MW for this interval; after ramp, full load
      const mw = minuteOffset >= rampMinutes ? config.loadMW : avgMWForInterval(minuteOffset, dur);

      const gasCostInterval = mw * config.heatRate * config.gasCostGJ * hrs;
      const revenue = mw * p.rrp * hrs;
      const margin = revenue - gasCostInterval;

      // Stop when price drops below SRMC (margin negative) and we've already recovered start cost
      // or when margin is negative past the ramp (wouldn't start running at a loss)
      if (margin < 0 && minuteOffset >= rampMinutes) break;

      minuteOffset += dur;
      cumBalance += margin;

      intervals.push({
        time: p.time,
        rrp: p.rrp,
        mw: Math.round(mw),
        gasCostInterval,
        revenue,
        margin,
        cumBalance,
      });
    }

    const recoveryIdx = intervals.findIndex((iv) => iv.cumBalance > 0);
    const recoveryTime = recoveryIdx >= 0 ? intervals[recoveryIdx].time : null;
    let recoveryMinutes: number | null = null;
    if (recoveryIdx >= 0) {
      recoveryMinutes = 0;
      for (let k = startIdx; k <= startIdx + recoveryIdx; k++) {
        recoveryMinutes += prices[k].durationMin;
      }
    }

    // Total run duration
    let totalRunMinutes = 0;
    for (let k = 0; k < intervals.length; k++) {
      totalRunMinutes += prices[startIdx + k].durationMin;
    }

    const lastInterval = intervals[intervals.length - 1];

    return {
      startTime: prices[startIdx].time,
      intervals,
      recoveryTime,
      recoveryMinutes,
      finalBalance: lastInterval?.cumBalance ?? -config.startCost,
      peakBalance: lastInterval?.cumBalance ?? -config.startCost,
      optimalStopTime: lastInterval?.time ?? null,
      optimalRunMinutes: intervals.length > 0 ? totalRunMinutes : null,
      optimalProfit: lastInterval?.cumBalance ?? -config.startCost,
    };
  }

  const analyses: StartAnalysis[] = [];
  for (let i = 0; i < prices.length; i++) {
    const a = analyseStart(i);
    if (a.peakBalance > -config.startCost) {
      analyses.push(a);
    }
  }

  // Sort: best final balance first, recovered starts prioritised
  analyses.sort((a, b) => {
    if (a.recoveryTime && !b.recoveryTime) return -1;
    if (!a.recoveryTime && b.recoveryTime) return 1;
    if (a.recoveryTime && b.recoveryTime) {
      return (a.recoveryMinutes ?? Infinity) - (b.recoveryMinutes ?? Infinity);
    }
    return b.finalBalance - a.finalBalance;
  });

  const result: StartCostResult = {
    config,
    regionId,
    srmc,
    allPrices: prices.map((p) => ({ time: p.time, rrp: p.rrp })),
    analyses: analyses.slice(0, 15),
    bestStart: analyses.length > 0 ? analyses[0] : null,
  };

  if (sensScenario) {
    result.sensScenario = sensScenario;
    const scenario = PD_SCENARIOS[sensScenario];
    if (scenario) {
      const sign = scenario.deltaMW > 0 ? "+" : "";
      result.sensLabel = `${scenario.region.replace("1", "")} ${sign}${scenario.deltaMW} MW`;
    }
  }

  return result;
}
