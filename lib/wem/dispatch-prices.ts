const DISPATCH_DIR =
  "https://data.wa.aemo.com.au/public/market-data/wemde/dispatchSolution/dispatchData/current/";

type DispatchInterval = {
  dispatchInterval: string;
  energy: number;
};

type DispatchPriceRow = {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  CURRENT_RRP: number;
  PREVIOUS_RRP: number;
  DELTA: number;
};

/** List dispatch files, return newest first */
async function listDispatchFiles(): Promise<string[]> {
  const res = await fetch(DISPATCH_DIR, { cache: "no-store" });
  if (!res.ok) throw new Error(`WEM dispatch dir: HTTP ${res.status}`);
  const html = await res.text();
  const re = /ReferenceDispatchSolution_\d+\.json/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) files.push(m[0]);
  files.sort((a, b) => b.localeCompare(a));
  return files;
}

/** Fetch a dispatch file and extract just interval + energy price */
async function fetchDispatchPrices(filename: string): Promise<DispatchInterval[]> {
  const res = await fetch(`${DISPATCH_DIR}${filename}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`WEM dispatch file: HTTP ${res.status}`);
  const json = await res.json();
  const solutions = json?.data?.solutionData ?? [];
  return solutions.map((s: Record<string, unknown>) => ({
    dispatchInterval: (s.dispatchInterval as string).replace("+08:00", "").replace("T", " "),
    energy: (s.prices as Record<string, number>).energy,
  }));
}

/**
 * Fetch the two latest WEM dispatch solutions and compare energy prices.
 * Returns price changes in the same format as NEM P5MIN price changes.
 */
export async function getWEMDispatchPriceChanges(): Promise<DispatchPriceRow[]> {
  const files = await listDispatchFiles();
  if (files.length < 2) throw new Error("WEM dispatch: need >= 2 files");

  const [current, previous] = await Promise.all([
    fetchDispatchPrices(files[0]),
    fetchDispatchPrices(files[1]),
  ]);

  // Build lookup from previous
  const prevMap = new Map<string, number>();
  for (const p of previous) prevMap.set(p.dispatchInterval, p.energy);

  const results: DispatchPriceRow[] = [];
  for (const c of current) {
    const prev = prevMap.get(c.dispatchInterval);
    if (prev === undefined) continue;
    results.push({
      INTERVAL_DATETIME: c.dispatchInterval.replace(" ", "T"),
      REGIONID: "WEM",
      CURRENT_RRP: c.energy,
      PREVIOUS_RRP: prev,
      DELTA: c.energy - prev,
    });
  }

  results.sort((a, b) => Math.abs(b.DELTA) - Math.abs(a.DELTA));
  return results;
}
