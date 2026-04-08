const AEMO_WA_CAPACITY_BASE =
  "https://data.wa.aemo.com.au/public/market-data/wemde/notInServiceCapacity/current/";

export type WEMOfflineUnit = {
  facilityCode: string;
  offlineMW: number;
};

/** Fetch the latest not-in-service capacity file */
export async function getWEMOfflineCapacity(): Promise<WEMOfflineUnit[]> {
  // List directory to find latest file
  const dirRes = await fetch(AEMO_WA_CAPACITY_BASE, { cache: "no-store" });
  if (!dirRes.ok) throw new Error(`AEMO WA capacity dir: HTTP ${dirRes.status}`);
  const html = await dirRes.text();

  // Extract JSON filenames, sort descending, take latest
  const re = /NotInServiceCapacity_\d+\.json/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) files.push(m[0]);
  files.sort((a, b) => b.localeCompare(a));

  if (files.length === 0) return [];

  const fileRes = await fetch(`${AEMO_WA_CAPACITY_BASE}${files[0]}`, { cache: "no-store" });
  if (!fileRes.ok) throw new Error(`AEMO WA capacity file: HTTP ${fileRes.status}`);
  const json = await fileRes.json();

  const items = json?.data?.[0]?.notInServiceCapacities ?? [];
  return items
    .filter((i: Record<string, unknown>) => typeof i.notInServiceCapacity === "number" && (i.notInServiceCapacity as number) > 0)
    .map((i: Record<string, unknown>) => ({
      facilityCode: i.facilityCode as string,
      offlineMW: i.notInServiceCapacity as number,
    }))
    .sort((a: WEMOfflineUnit, b: WEMOfflineUnit) => b.offlineMW - a.offlineMW);
}
