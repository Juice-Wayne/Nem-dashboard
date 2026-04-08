const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";

// Key WEM facilities to track
const FACILITIES = [
  "COLLIE_G1", "MUJA_G5", "MUJA_G6", "MUJA_G7", "MUJA_G8",
  "NEWGEN_KWINANA_CCG1", "NEWGEN_NEERABUP_GT1",
  "ALINTA_PNJ_U1", "ALINTA_PNJ_U2", "ALINTA_WGP",
  "ALBANY_WF1", "GRASMERE_WF1", "YANDIN_WF1",
  "GREENOUGH_RIVER_PV1", "MERREDIN_SFM",
];

export type WEMFacilityGen = {
  facilityCode: string;
  currentMW: number;        // latest 5-min reading
};

/** Build AWST "from" for last 30 min of data */
function awstRecent(): string {
  const awst = new Date(Date.now() + 8 * 60 * 60 * 1000);
  awst.setUTCMinutes(awst.getUTCMinutes() - 30);
  const y = awst.getUTCFullYear();
  const mo = String(awst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(awst.getUTCDate()).padStart(2, "0");
  const h = String(awst.getUTCHours()).padStart(2, "0");
  const m = String(awst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${m}`;
}

export async function getWEMGeneration(): Promise<WEMFacilityGen[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  const from = awstRecent();
  // Fetch all facilities in parallel
  const results = await Promise.all(
    FACILITIES.map(async (code) => {
      try {
        const url = `${NEOPOINT_BASE}?f=401%20WEM%5CFacility%20Generation&from=${encodeURIComponent(from)}&period=Two%20Hours&instances=${code}&section=-1&key=${apiKey}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        const data: Record<string, unknown>[] = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        // Take the last non-null reading
        for (let i = data.length - 1; i >= 0; i--) {
          const gen = data[i][".Generation"];
          if (gen !== null && typeof gen === "number") {
            return { facilityCode: code, currentMW: gen };
          }
        }
        return null;
      } catch {
        return null;
      }
    }),
  );

  return results
    .filter((r): r is WEMFacilityGen => r !== null)
    .sort((a, b) => b.currentMW - a.currentMW);
}
