// WEM Market Summary — fetches real-time data from AEMO WA + Open-Meteo
// Data sources:
//   - Operational demand: AEMO WA real-time JSON
//   - Outages: derived from dispatch solution (thermal units absent = offline)
//   - Generation: AEMO WA dispatch solution (energy facilitySchedule)
//   - Temperature: Open-Meteo (Perth)

const AEMO_WA_BASE = "https://data.wa.aemo.com.au/public/market-data/wemde";

// --- Caching ---

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const c = cache.get(key);
  if (c && c.expiry > Date.now()) return c.data as T;
  return null;
}

function setCache<T>(key: string, data: T, ttlMs: number): T {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
  return data;
}

// --- Facility fuel type classification ---

type FuelType = "coal" | "gas" | "wind" | "solar" | "battery" | "distillate" | "biomass" | "other";

// Known facility → fuel mappings (based on AEMO WEM facility registry + market knowledge)
const FACILITY_FUEL_MAP: Record<string, FuelType> = {
  // Coal
  COLLIE_G1: "coal",
  MUJA_G5: "coal",
  MUJA_G6: "coal",
  MUJA_G7: "coal",
  MUJA_G8: "coal",
  BW1_BLUEWATERS_G2: "coal",
  BW2_BLUEWATERS_G1: "coal",
  // Gas — CCGTs
  COCKBURN_CCG1: "gas",
  NEWGEN_KWINANA_CCG1: "gas",
  // Gas — OCGTs / steam
  NEWGEN_NEERABUP_GT1: "gas",
  ALINTA_PNJ_U1: "gas",
  ALINTA_PNJ_U2: "gas",
  ALINTA_WGP_GT: "gas",
  ALINTA_WGP_U2: "gas",
  ALCOA_WGP: "gas",
  KEMERTON_GT11: "gas",
  KEMERTON_GT12: "gas",
  KWINANA_GT2: "gas",
  KWINANA_GT3: "gas",
  PINJAR_GT1: "gas",
  PINJAR_GT2: "gas",
  PINJAR_GT3: "gas",
  PINJAR_GT4: "gas",
  PINJAR_GT5: "gas",
  PINJAR_GT7: "gas",
  PINJAR_GT9: "gas",
  PINJAR_GT10: "gas",
  PINJAR_GT11: "gas",
  PRK_AG: "gas",
  NAMKKN_MERR_SG1: "gas",
  PERTHENERGY_KWINANA_GT1: "gas",
  MUNGARRA_GT1: "gas",
  MUNGARRA_GT3: "gas",
  WEST_KALGOORLIE_GT2: "gas",
  WEST_KALGOORLIE_GT3: "gas",
  STHRNCRS_EG: "gas",
  TESLA_PICTON_G1: "gas",
  TESLA_GERALDTON_G1: "gas",
  TESLA_KEMERTON_G1: "gas",
  TESLA_NORTHAM_G1: "gas",
  TIWEST_COG1: "gas",
  // Wind
  ALBANY_WF1: "wind",
  GRASMERE_WF1: "wind",
  YANDIN_WF1: "wind",
  BADGINGARRA_WF1: "wind",
  WARRADARGE_WF1: "wind",
  INVESTEC_COLLGAR_WF1: "wind",
  EDWFMAN_WF1: "wind",
  MWF_MUMBIDA_WF1: "wind",
  ALINTA_WWF: "wind",
  BREMER_BAY_WF1: "wind",
  KALBARRI_WF1: "wind",
  DCWL_DENMARK_WF1: "wind",
  BLAIRFOX_BEROSRD_WF1: "wind",
  BLAIRFOX_KARAKIN_WF1: "wind",
  BLAIRFOX_WESTHILLS_WF3: "wind",
  SKYFRM_MTBARKER_WF1: "wind",
  FLATROCKS_WF1: "wind",
  // Solar
  GREENOUGH_RIVER_PV1: "solar",
  MERSOLAR_PV1: "solar",
  AMBRISOLAR_PV1: "solar",
  NORTHAM_SF_PV1: "solar",
  // Battery / ESR
  KWINANA_ESR1: "battery",
  COLLIE_ESR1: "battery",
  COLLIE_BESS1: "battery",
  COLLIE_BESS2: "battery",
  WANDOAN_BESS1: "battery",
  // Biomass / landfill / waste-to-energy
  BRIDGETOWN_BIOMASS_PLANT: "biomass",
  RED_HILL: "biomass",
  TAMALA_PARK: "biomass",
  HENDERSON_RENEWABLE_IG1: "biomass",
  BIOGAS01: "biomass",
  KALAMUNDA_SG: "biomass",
  PHOENIX_KWINANA_WTE_G1: "biomass",
  // Hydro
  PRDSO_WALPOLE_HG1: "other",
  // Other misc
  SOUTH_CARDUP: "biomass",
};

// Known facility capacities (MW)
const FACILITY_CAPACITY: Record<string, number> = {
  COLLIE_G1: 318, MUJA_G5: 194, MUJA_G6: 194, MUJA_G7: 213, MUJA_G8: 213,
  BW1_BLUEWATERS_G2: 217, BW2_BLUEWATERS_G1: 217,
  COCKBURN_CCG1: 250, NEWGEN_KWINANA_CCG1: 335, NEWGEN_NEERABUP_GT1: 342,
  ALINTA_PNJ_U1: 143, ALINTA_PNJ_U2: 143, ALINTA_WGP_GT: 196, ALINTA_WGP_U2: 196,
  KEMERTON_GT11: 155, KEMERTON_GT12: 155, KWINANA_GT2: 103, KWINANA_GT3: 103,
  PINJAR_GT1: 39, PINJAR_GT2: 39, PINJAR_GT3: 39, PINJAR_GT4: 39,
  PINJAR_GT5: 39, PINJAR_GT7: 39, PINJAR_GT9: 118, PINJAR_GT10: 118, PINJAR_GT11: 130,
  PRK_AG: 68, NAMKKN_MERR_SG1: 82, PERTHENERGY_KWINANA_GT1: 109,
  YANDIN_WF1: 212, INVESTEC_COLLGAR_WF1: 219, BADGINGARRA_WF1: 130,
  WARRADARGE_WF1: 180, EDWFMAN_WF1: 80, MWF_MUMBIDA_WF1: 55,
  ALBANY_WF1: 22, GRASMERE_WF1: 14, ALINTA_WWF: 89,
  GREENOUGH_RIVER_PV1: 40, MERSOLAR_PV1: 100,
  KWINANA_ESR1: 100, COLLIE_ESR1: 100,
};

// Friendly names for display
const FACILITY_NAMES: Record<string, string> = {
  COLLIE_G1: "Collie G1", MUJA_G5: "Muja G5", MUJA_G6: "Muja G6", MUJA_G7: "Muja G7", MUJA_G8: "Muja G8",
  BW1_BLUEWATERS_G2: "Bluewaters G2", BW2_BLUEWATERS_G1: "Bluewaters G1",
  COCKBURN_CCG1: "Cockburn CCG1", NEWGEN_KWINANA_CCG1: "NewGen Kwinana", NEWGEN_NEERABUP_GT1: "NewGen Neerabup",
  ALINTA_PNJ_U1: "PNJ U1", ALINTA_PNJ_U2: "PNJ U2",
  ALINTA_WGP_GT: "WGP GT", ALINTA_WGP_U2: "WGP U2",
  ALCOA_WGP: "Alcoa WGP",
  KEMERTON_GT11: "Kemerton GT11", KEMERTON_GT12: "Kemerton GT12",
  KWINANA_GT2: "Kwinana GT2", KWINANA_GT3: "Kwinana GT3",
  PINJAR_GT1: "Pinjar GT1", PINJAR_GT2: "Pinjar GT2", PINJAR_GT3: "Pinjar GT3",
  PINJAR_GT4: "Pinjar GT4", PINJAR_GT5: "Pinjar GT5", PINJAR_GT7: "Pinjar GT7",
  PINJAR_GT9: "Pinjar GT9", PINJAR_GT10: "Pinjar GT10", PINJAR_GT11: "Pinjar GT11",
  PRK_AG: "Parkeston", NAMKKN_MERR_SG1: "Merredin",
  PERTHENERGY_KWINANA_GT1: "Perth Energy Kwinana",
  YANDIN_WF1: "Yandin", INVESTEC_COLLGAR_WF1: "Collgar", BADGINGARRA_WF1: "Badgingarra",
  WARRADARGE_WF1: "Warradarge", EDWFMAN_WF1: "Emu Downs", MWF_MUMBIDA_WF1: "Mumbida",
  ALBANY_WF1: "Albany", GRASMERE_WF1: "Grasmere", ALINTA_WWF: "Walkaway",
  GREENOUGH_RIVER_PV1: "Greenough River", MERSOLAR_PV1: "Merredin Solar",
  KWINANA_ESR1: "Kwinana ESR", COLLIE_ESR1: "Collie ESR",
};

// Thermal facilities to track for outage detection.
// Only baseload/mid-merit units — peaking OCGTs (Pinjar, Kemerton, etc.) are
// frequently not dispatched and absence doesn't imply an outage.
const TRACKED_THERMAL: Record<string, number> = {
  // Coal — always expected online unless on outage
  COLLIE_G1: 318,
  MUJA_G5: 194,
  MUJA_G6: 194,
  MUJA_G7: 213,
  MUJA_G8: 213,
  BW1_BLUEWATERS_G2: 217,
  BW2_BLUEWATERS_G1: 217,
  // Gas — baseload / mid-merit CCGTs + large units
  COCKBURN_CCG1: 250,
  NEWGEN_KWINANA_CCG1: 335,
  NEWGEN_NEERABUP_GT1: 342,
  ALINTA_PNJ_U1: 143,
  ALINTA_PNJ_U2: 143,
  ALINTA_WGP_GT: 196,
  ALINTA_WGP_U2: 196,
};

/** Classify a facility code by fuel type, using known map then naming patterns */
function classifyFacility(code: string): FuelType {
  if (FACILITY_FUEL_MAP[code]) return FACILITY_FUEL_MAP[code];
  // Pattern-based fallback
  if (/_WF\d*$/.test(code) || /_WWF/.test(code)) return "wind";
  if (/_PV\d*$/.test(code) || /_SF_PV/.test(code) || /SOLAR/.test(code)) return "solar";
  if (/_ESR\d*$/.test(code) || /_BESS\d*$/.test(code)) return "battery";
  if (/_GT\d*$/.test(code) || /_CCG\d*$/.test(code)) return "gas";
  if (/_G\d+$/.test(code)) return "coal"; // generic G# suffix — likely coal/gas scheduled
  return "other";
}

function facilityName(code: string): string {
  return FACILITY_NAMES[code] ?? code.replace(/_/g, " ");
}

// --- Types ---

export interface WEMOutage {
  facilityCode: string;
  name: string;
  offlineMW: number;      // MW of capacity unavailable
  maxCapacity: number;     // rated capacity
  availableMW: number;     // current available capacity
  fuelType: FuelType;
  type: "full" | "limited"; // full = 0 MW avail, limited = derated
  expectedReturn: string | null; // ISO timestamp of first interval where avail returns
}

export interface WEMUpcomingOutage {
  facilityCode: string;
  name: string;
  maxCapacity: number;
  fuelType: FuelType;
  outageStart: string;     // ISO timestamp when availability drops to 0
  expectedReturn: string | null;
}

export interface WEMFacilityOutput {
  facilityCode: string;
  name: string;
  mw: number;
  fuelType: FuelType;
}

export interface WEMGenerationMix {
  coal: number;
  gas: number;
  wind: number;
  solar: number;
  battery: number;
  distillate: number;
  biomass: number;
  other: number;
  total: number;
  facilities: WEMFacilityOutput[];
}

export interface WEMMarketSummary {
  timestamp: string;
  temp: { today: number | null; tomorrow: number | null };
  demand: { currentMW: number; withdrawalMW: number; asAt: string } | null;
  generation: WEMGenerationMix | null;
  outages: WEMOutage[];
  upcomingOutages: WEMUpcomingOutage[];
}

// --- Fetchers ---

/** Fetch real-time operational demand from AEMO WA */
async function fetchWEMDemand(): Promise<WEMMarketSummary["demand"]> {
  const url = `${AEMO_WA_BASE}/operationalDemandWithdrawal/realTime/OperationalDemandAndWithdrawalEstimate.json`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`AEMO WA demand: HTTP ${res.status}`);
  const json = await res.json();
  const d = json?.data?.data;
  if (!d) throw new Error("AEMO WA demand: unexpected response");
  return {
    currentMW: d.operationalDemandEstimate,
    withdrawalMW: d.operationalWithdrawalEstimate,
    asAt: d.asAtTimeStamp,
  };
}

/** Helper: find latest file matching a regex pattern from an AEMO directory listing */
async function findLatestFile(dirUrl: string, pattern: RegExp): Promise<string | null> {
  const dirRes = await fetch(dirUrl, { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!dirRes.ok) return null;
  const html = await dirRes.text();
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) files.push(m[0]);
  files.sort((a, b) => b.localeCompare(a));
  return files.length > 0 ? files[0] : null;
}

/** Extract energy facilitySchedule from a dispatch solution JSON */
function extractEnergySchedule(json: Record<string, unknown>): { facilityCode: string; quantity: number }[] | null {
  const data = json?.data as Record<string, unknown> | undefined;
  const schedules = (data?.schedule ?? ((data?.solutionData as Record<string, unknown>[])?.[0] as Record<string, unknown>)?.schedule ?? []) as Record<string, unknown>[];
  for (const svc of schedules) {
    const serviceType = (svc.serviceType ?? svc.marketService ?? "") as string;
    if (serviceType.toLowerCase() === "energy") {
      return (svc.facilitySchedules ?? svc.facilitySchedule ?? []) as { facilityCode: string; quantity: number }[];
    }
  }
  return null;
}

/**
 * Fetch pre-dispatch AvailableCapacity to find outage return dates.
 * Scans forward through forecast intervals to find when each outaged unit returns.
 * Returns a map: facilityCode → first interval timestamp where avail > 5 MW.
 * Cached for 10 minutes (outage returns don't change frequently).
 */
interface PreDispatchResult {
  returnDates: Map<string, string>;          // outaged code → first interval where avail > 5
  upcoming: WEMUpcomingOutage[];             // units currently available that go offline
}

let preDispatchCache: { data: PreDispatchResult; fetchedAt: number } | null = null;
const PD_CACHE_TTL = 10 * 60_000; // 10 minutes

async function fetchPreDispatchAvailability(
  currentOutages: WEMOutage[],
  currentAvailableCodes: Set<string>,
): Promise<PreDispatchResult> {
  const empty: PreDispatchResult = { returnDates: new Map(), upcoming: [] };

  // Check cache
  if (preDispatchCache && Date.now() - preDispatchCache.fetchedAt < PD_CACHE_TTL) {
    return preDispatchCache.data;
  }

  // Build lookup: code → threshold MW for "returned"
  // Full outages: return when > 5 MW. Limited: return when > 80% of rated.
  const returnThreshold = new Map<string, number>();
  for (const o of currentOutages) {
    returnThreshold.set(o.facilityCode, o.type === "full" ? 5 : o.maxCapacity * 0.8);
  }

  const pdAcDir = `${AEMO_WA_BASE}/dispatchSolution/preDispatchData-AvailableCapacity/current/`;
  try {
    const latestFile = await findLatestFile(pdAcDir, /AvailableCapacityPre-DispatchSolution_\d+\.json/g);
    if (!latestFile) return empty;

    // ~97MB — heavy but necessary for return/upcoming dates
    const res = await fetch(`${pdAcDir}${latestFile}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return empty;
    const json = await res.json();

    const solutionData = (json?.data?.solutionData ?? []) as Record<string, unknown>[];
    const intervals = solutionData
      .map((sd) => ({
        interval: (sd.dispatchInterval ?? sd.interval ?? "") as string,
        schedule: (sd.schedule ?? []) as Record<string, unknown>[],
      }))
      .filter((iv) => iv.interval)
      .sort((a, b) => a.interval.localeCompare(b.interval));

    // --- Return dates for current outages ---
    const returnDates = new Map<string, string>();
    const outageSet = new Set(currentOutages.map((o) => o.facilityCode));

    // --- Upcoming outages: track per-interval availability for currently-available units ---
    // For each tracked thermal unit that's currently available, scan for future intervals
    // where availability drops to 0
    const upcomingMap = new Map<string, { outageStart: string; expectedReturn: string | null }>();
    // Track state per facility: true = was available in previous interval
    const wasAvailable = new Map<string, boolean>();
    for (const code of Object.keys(TRACKED_THERMAL)) {
      wasAvailable.set(code, currentAvailableCodes.has(code));
    }

    for (const iv of intervals) {
      for (const svc of iv.schedule) {
        const serviceType = (svc.serviceType ?? svc.marketService ?? "") as string;
        if (serviceType.toLowerCase() !== "energy") continue;

        const facilities = (svc.facilitySchedules ?? svc.facilitySchedule ?? []) as { facilityCode?: string; code?: string; quantity?: number }[];
        const availThisInterval = new Map<string, number>();
        for (const fs of facilities) {
          const code = fs.facilityCode ?? fs.code;
          const mw = typeof fs.quantity === "number" ? fs.quantity : 0;
          if (code) availThisInterval.set(code, mw);
        }

        // Check return dates for current outages (use per-type threshold)
        for (const code of [...outageSet]) {
          const avail = availThisInterval.get(code) ?? 0;
          const threshold = returnThreshold.get(code) ?? 5;
          if (avail > threshold) {
            returnDates.set(code, iv.interval);
            outageSet.delete(code);
          }
        }

        // Check upcoming outages — was available, now goes to 0
        const outageFacilityCodes = currentOutages.map((o) => o.facilityCode);
        for (const [code, capacity] of Object.entries(TRACKED_THERMAL)) {
          if (outageFacilityCodes.includes(code)) continue; // already on outage
          const avail = availThisInterval.get(code) ?? 0;
          const prevAvail = wasAvailable.get(code) ?? false;

          if (prevAvail && avail <= 5 && !upcomingMap.has(code)) {
            // Transition from available to unavailable
            upcomingMap.set(code, { outageStart: iv.interval, expectedReturn: null });
          } else if (!prevAvail && avail > 5 && upcomingMap.has(code) && !upcomingMap.get(code)!.expectedReturn) {
            // Comes back — set return date
            upcomingMap.get(code)!.expectedReturn = iv.interval;
          }

          wasAvailable.set(code, avail > 5);
        }

        break; // only need energy service
      }
    }

    const upcoming: WEMUpcomingOutage[] = [];
    for (const [code, info] of upcomingMap) {
      upcoming.push({
        facilityCode: code,
        name: facilityName(code),
        maxCapacity: TRACKED_THERMAL[code],
        fuelType: classifyFacility(code),
        outageStart: info.outageStart,
        expectedReturn: info.expectedReturn,
      });
    }
    upcoming.sort((a, b) => a.outageStart.localeCompare(b.outageStart));

    const result: PreDispatchResult = { returnDates, upcoming };
    preDispatchCache = { data: result, fetchedAt: Date.now() };
    return result;
  } catch (err) {
    console.warn("[wem] pre-dispatch AvailableCapacity fetch failed:", err instanceof Error ? err.message : err);
    return empty;
  }
}

/** Fetch current generation from dispatch solution + detect outages from NotInServiceCapacity */
async function fetchWEMDispatch(): Promise<{ generation: WEMGenerationMix; outages: WEMOutage[]; upcomingOutages: WEMUpcomingOutage[]; currentlyAvailable: Set<string> } | null> {
  try {
    // Reference dispatch → generation mix (outages now come from a separate endpoint).
    const refDirUrl = `${AEMO_WA_BASE}/dispatchSolution/dispatchData/current/`;
    const refFile = await findLatestFile(refDirUrl, /ReferenceDispatchSolution_\d+\.json/g);
    if (!refFile) return null;

    // Fetch the Reference dispatch (~23MB) — always needed for generation mix
    const refRes = await fetch(`${refDirUrl}${refFile}`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!refRes.ok) return null;
    const refJson = await refRes.json();

    const energySchedule = extractEnergySchedule(refJson);
    if (!energySchedule) return null;

    // Build generation mix from Reference dispatch
    const mix: WEMGenerationMix = {
      coal: 0, gas: 0, wind: 0, solar: 0, battery: 0,
      distillate: 0, biomass: 0, other: 0, total: 0,
      facilities: [],
    };

    for (const fs of energySchedule) {
      const code = fs.facilityCode ?? (fs as Record<string, unknown>).code as string;
      const mw = typeof fs.quantity === "number" ? fs.quantity : 0;
      if (!code || mw === 0) continue;

      const fuel = classifyFacility(code);
      if (mw > 0) {
        mix[fuel] += mw;
        mix.total += mw;
      }

      mix.facilities.push({
        facilityCode: code,
        name: facilityName(code),
        mw: Math.round(mw * 10) / 10,
        fuelType: fuel,
      });
    }

    mix.coal = Math.round(mix.coal);
    mix.gas = Math.round(mix.gas);
    mix.wind = Math.round(mix.wind);
    mix.solar = Math.round(mix.solar);
    mix.battery = Math.round(mix.battery);
    mix.distillate = Math.round(mix.distillate);
    mix.biomass = Math.round(mix.biomass);
    mix.other = Math.round(mix.other);
    mix.total = Math.round(mix.total);
    mix.facilities.sort((a, b) => b.mw - a.mw);

    // --- Outage detection from NotInServiceCapacity ---
    // Source of truth: AEMO WEMDE /notInServiceCapacity/ publishes, for every facility,
    // the MW of capacity currently declared not-in-service (i.e. genuine outages /
    // deratings). If notInServiceCapacity == 0, the unit IS available — whether or not
    // it's dispatched is a commercial decision, not an outage.
    const outages: WEMOutage[] = [];
    const currentlyAvailable = new Set<string>();

    try {
      const nisDir = `${AEMO_WA_BASE}/notInServiceCapacity/current/`;
      const nisFile = await findLatestFile(nisDir, /NotInServiceCapacity_\d+\.json/g);
      if (!nisFile) throw new Error("no NotInServiceCapacity file found");

      const nisRes = await fetch(`${nisDir}${nisFile}`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
      if (!nisRes.ok) throw new Error(`NIS HTTP ${nisRes.status}`);
      const nisJson = await nisRes.json();

      // Shape: { data: [ { notInServiceCapacities: [ { facilityCode, notInServiceCapacity } ] } ] }
      const entries = nisJson?.data?.[0]?.notInServiceCapacities as Array<{ facilityCode?: string; notInServiceCapacity?: number }> | undefined;
      const nisMap = new Map<string, number>();
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e.facilityCode) nisMap.set(e.facilityCode, Number(e.notInServiceCapacity) || 0);
        }
      }

      // Show an outage for every facility AEMO lists as NIS > 0, regardless of whether
      // it's in TRACKED_THERMAL — the user wants ground truth from AEMO, and NIS > 0
      // *is* the definition of an outage. Rated capacity (for "full vs limited" labelling)
      // comes from TRACKED_THERMAL when available, else we omit the classification.
      for (const [code, nisMW] of nisMap) {
        if (nisMW <= 0.5) {
          currentlyAvailable.add(code);
          continue;
        }
        const ratedCapacity = TRACKED_THERMAL[code];
        const maxCapacity = ratedCapacity ?? Math.round(nisMW); // best-effort when unknown
        const avail = ratedCapacity != null ? Math.max(0, ratedCapacity - nisMW) : 0;
        const fullyOut = ratedCapacity == null ? false : avail <= 0.5;
        outages.push({
          facilityCode: code,
          name: facilityName(code),
          offlineMW: Math.round(Math.min(nisMW, maxCapacity)),
          maxCapacity,
          availableMW: Math.round(avail),
          fuelType: classifyFacility(code),
          type: fullyOut ? "full" : "limited",
          expectedReturn: null,
        });
      }

      // Any TRACKED unit not already flagged as NIS is available for upcoming-outage tracking.
      for (const code of Object.keys(TRACKED_THERMAL)) {
        const nisMW = nisMap.get(code) ?? 0;
        if (nisMW <= 0.5) currentlyAvailable.add(code);
      }
    } catch (err) {
      console.warn("[wem] NotInServiceCapacity fetch failed, no outage info available:", err instanceof Error ? err.message : err);
      // On failure, assume every tracked unit is available — better than false outage alerts.
      for (const code of Object.keys(TRACKED_THERMAL)) currentlyAvailable.add(code);
    }

    // Sort: full outages first, then limited, by MW desc
    outages.sort((a, b) => {
      if (a.type !== b.type) return a.type === "full" ? -1 : 1;
      return b.offlineMW - a.offlineMW;
    });

    return { generation: mix, outages, upcomingOutages: [], currentlyAvailable };
  } catch (err) {
    console.warn("[wem] dispatch solution fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Fetch week-ahead AvailableCapacity for longer-horizon return dates.
 * ~337MB file, updates daily at 08:00 AWST. Cached for 30 minutes.
 * Only called for outages that don't have a return date from pre-dispatch.
 */
let weekAheadCache: { data: Map<string, string>; fetchedAt: number } | null = null;
const WA_CACHE_TTL = 30 * 60_000; // 30 minutes

async function fetchWeekAheadReturnDates(codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  if (weekAheadCache && Date.now() - weekAheadCache.fetchedAt < WA_CACHE_TTL) {
    return weekAheadCache.data;
  }

  const waDir = `${AEMO_WA_BASE}/dispatchSolution/weekAheadDispatchData-AvailableCapacity/current/`;
  try {
    const latestFile = await findLatestFile(waDir, /AvailableCapacityWeekAhead-DispatchSolution_\d+\.json/g);
    if (!latestFile) return new Map();

    // ~337MB — only fetch when needed, cache aggressively
    const res = await fetch(`${waDir}${latestFile}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(120000), // 2 min timeout
    });
    if (!res.ok) return new Map();
    const json = await res.json();

    const solutionData = (json?.data?.solutionData ?? []) as Record<string, unknown>[];
    const intervals = solutionData
      .map((sd) => ({
        interval: (sd.dispatchInterval ?? sd.interval ?? "") as string,
        schedule: (sd.schedule ?? []) as Record<string, unknown>[],
      }))
      .filter((iv) => iv.interval)
      .sort((a, b) => a.interval.localeCompare(b.interval));

    const returnDates = new Map<string, string>();
    const remaining = new Set(codes);

    for (const iv of intervals) {
      if (remaining.size === 0) break;
      for (const svc of iv.schedule) {
        const serviceType = (svc.serviceType ?? svc.marketService ?? "") as string;
        if (serviceType.toLowerCase() !== "energy") continue;
        const facilities = (svc.facilitySchedules ?? svc.facilitySchedule ?? []) as { facilityCode?: string; code?: string; quantity?: number }[];
        for (const fs of facilities) {
          const code = fs.facilityCode ?? fs.code;
          if (!code || !remaining.has(code)) continue;
          if ((typeof fs.quantity === "number" ? fs.quantity : 0) > 5) {
            returnDates.set(code, iv.interval);
            remaining.delete(code);
          }
        }
        break;
      }
    }

    weekAheadCache = { data: returnDates, fetchedAt: Date.now() };
    return returnDates;
  } catch (err) {
    console.warn("[wem] week-ahead AvailableCapacity fetch failed:", err instanceof Error ? err.message : err);
    return new Map();
  }
}

/** Fetch Perth temperature from Open-Meteo */
let tempCache: { today: number | null; tomorrow: number | null; fetchedAt: number } | null = null;
const TEMP_CACHE_TTL = 30 * 60_000; // 30 minutes

async function fetchPerthTemp(): Promise<{ today: number | null; tomorrow: number | null }> {
  if (tempCache && Date.now() - tempCache.fetchedAt < TEMP_CACHE_TTL) {
    return { today: tempCache.today, tomorrow: tempCache.tomorrow };
  }
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=-31.95&longitude=115.86&daily=temperature_2m_max&timezone=Australia%2FPerth&forecast_days=2";
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const json = await res.json();
    const temps = json?.daily?.temperature_2m_max;
    const result = {
      today: typeof temps?.[0] === "number" ? Math.round(temps[0]) : null,
      tomorrow: typeof temps?.[1] === "number" ? Math.round(temps[1]) : null,
    };
    tempCache = { ...result, fetchedAt: Date.now() };
    return result;
  } catch (err) {
    console.warn("[wem] Perth temp fetch failed:", err instanceof Error ? err.message : err);
    return { today: null, tomorrow: null };
  }
}

// --- Main entry ---

async function safe<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[wem] ${label} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getWEMMarketSummary(): Promise<WEMMarketSummary> {
  const cached = getCached<WEMMarketSummary>("wemMarket");
  if (cached) return cached;

  // Fetch all data in parallel
  const [demand, dispatch, temp] = await Promise.all([
    safe(fetchWEMDemand, "demand"),
    safe(fetchWEMDispatch, "dispatch"),
    safe(fetchPerthTemp, "temp").then((r) => r ?? { today: null, tomorrow: null }),
  ]);

  const outages = dispatch?.outages ?? [];

  // Upcoming outages are intentionally NOT derived from pre-dispatch AvailableCapacity:
  // that feed drops to 0 when a unit simply isn't dispatched (price reasons), which
  // produces a flood of false positives (e.g. WGP GT flagged "from tomorrow"). AEMO
  // doesn't publish a forward-looking NotInServiceCapacity feed, so we don't show
  // upcoming outages rather than show wrong ones.
  const upcomingOutages: WEMUpcomingOutage[] = [];

  const result: WEMMarketSummary = {
    timestamp: new Date().toISOString(),
    temp,
    demand,
    generation: dispatch?.generation ?? null,
    outages,
    upcomingOutages,
  };

  return setCache("wemMarket", result, 60_000); // 60s cache
}
