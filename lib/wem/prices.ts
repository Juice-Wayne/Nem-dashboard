const NEOPOINT_BASE = "https://neopoint.com.au/Service/Json";

export type WEMPrice = {
  DateTime: string;       // "2026-04-08T10:05:00"
  FinalPrice: number;     // $/MWh
};

/** Build AWST "from" param — start of today */
function awstToday(): string {
  // AWST = UTC+8
  const awst = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = awst.getUTCFullYear();
  const mo = String(awst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(awst.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d} 00:00`;
}

export async function getWEMPrices(): Promise<WEMPrice[]> {
  const apiKey = process.env.NEOPOINT_API_KEY;
  if (!apiKey) throw new Error("NEOPOINT_API_KEY not set");

  const from = awstToday();
  const url = `${NEOPOINT_BASE}?f=401%20WEM%5CEnergy%20Price&from=${encodeURIComponent(from)}&period=Daily&instances=&section=-1&key=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Neopoint WEM prices: HTTP ${res.status}`);
  const data: Record<string, unknown>[] = await res.json();

  return data
    .filter((r) => r[".Final Price"] !== null && typeof r[".Final Price"] === "number")
    .map((r) => ({
      DateTime: (r.DateTime as string).replace(" ", "T"),
      FinalPrice: r[".Final Price"] as number,
    }));
}
