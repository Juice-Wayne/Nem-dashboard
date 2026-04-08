const AEMO_WA_DEMAND_URL =
  "https://data.wa.aemo.com.au/public/market-data/wemde/operationalDemandWithdrawal/realTime/OperationalDemandAndWithdrawalEstimate.json";

export type WEMDemand = {
  asAt: string;             // ISO timestamp AWST
  demandMW: number;         // operational demand estimate
  withdrawalMW: number;     // behind-the-meter (negative = generation)
};

export async function getWEMDemand(): Promise<WEMDemand> {
  const res = await fetch(AEMO_WA_DEMAND_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`AEMO WA demand: HTTP ${res.status}`);
  const json = await res.json();
  const d = json?.data?.data;
  if (!d) throw new Error("AEMO WA demand: unexpected response shape");

  return {
    asAt: d.asAtTimeStamp,
    demandMW: d.operationalDemandEstimate,
    withdrawalMW: d.operationalWithdrawalEstimate,
  };
}
