import { NextRequest, NextResponse } from "next/server";

import {
  getGenerationStack,
  getBindingConstraints,
  getFcasPrices,
  getBidStack,
  getRebidFeed,
  getPriceSpikes,
  getRooftopPV,
  getReserveMargins,
  getStartCostAnalysis,
  DEFAULT_START_COST_CONFIG,
  clearResultCache,
  clearDirCache,
  getDuidFuelMap,
} from "@/lib/nemweb";

async function safeQuery<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[analytics] ${label} query failed:`, error instanceof Error ? error.message : error);
    return [];
  }
}

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" };

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.has("force")) {
      clearResultCache();
      clearDirCache();
    }

    const tab = request.nextUrl.searchParams.get("tab");

    if (tab === "generation") {
      const data = await safeQuery(getGenerationStack, "DISPATCH_UNIT_SCADA");
      return NextResponse.json({ generation: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "constraints") {
      const data = await safeQuery(getBindingConstraints, "DISPATCH_CONSTRAINT");
      return NextResponse.json({ constraints: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "fcas") {
      const data = await safeQuery(getFcasPrices, "FCAS_PRICES");
      return NextResponse.json({ fcas: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "bidstack") {
      const data = await safeQuery(getBidStack, "BIDMOVE_COMPLETE");
      return NextResponse.json({ bidstack: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "rooftoppv") {
      const data = await safeQuery(getRooftopPV, "ROOFTOP_PV");
      return NextResponse.json({ rooftoppv: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "reserves") {
      const data = await safeQuery(getReserveMargins, "STPASA");
      return NextResponse.json({ reserves: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "rebids") {
      const [data, fuelMap] = await Promise.all([
        safeQuery(getRebidFeed, "BIDMOVE_REBIDS"),
        getDuidFuelMap().catch(() => new Map()),
      ]);
      // Convert Map to plain object for JSON
      const fuel: Record<string, string> = {};
      for (const [k, v] of fuelMap) fuel[k] = v;
      return NextResponse.json({ rebids: data, fuel }, { headers: CACHE_HEADERS });
    }

    if (tab === "spikes") {
      const hours = Number(request.nextUrl.searchParams.get("hours")) || 3;
      const data = await safeQuery(() => getPriceSpikes(hours), "PRICE_SPIKES");
      return NextResponse.json({ spikes: data }, { headers: CACHE_HEADERS });
    }

    if (tab === "startcost") {
      const region = request.nextUrl.searchParams.get("region") || "QLD1";
      const sp = request.nextUrl.searchParams;
      const config = {
        gasCostGJ: Number(sp.get("gasCostGJ")) || DEFAULT_START_COST_CONFIG.gasCostGJ,
        startCost: sp.has("startCost") ? Number(sp.get("startCost")) : DEFAULT_START_COST_CONFIG.startCost,
        loadMW: Number(sp.get("loadMW")) || DEFAULT_START_COST_CONFIG.loadMW,
        heatRate: Number(sp.get("heatRate")) || DEFAULT_START_COST_CONFIG.heatRate,
        rampRateMWMin: Number(sp.get("rampRate")) || DEFAULT_START_COST_CONFIG.rampRateMWMin,
      };
      const day = (sp.get("day") === "d+1" ? "d+1" : "today") as "today" | "d+1";
      const data = await getStartCostAnalysis(region, config, day);
      return NextResponse.json({ startcost: data }, { headers: CACHE_HEADERS });
    }

    // Default: return all
    const [generation, constraints, fcas, bidstack, rooftoppv, reserves] = await Promise.all([
      safeQuery(getGenerationStack, "DISPATCH_UNIT_SCADA"),
      safeQuery(getBindingConstraints, "DISPATCH_CONSTRAINT"),
      safeQuery(getFcasPrices, "FCAS_PRICES"),
      safeQuery(getBidStack, "BIDMOVE_COMPLETE"),
      safeQuery(getRooftopPV, "ROOFTOP_PV"),
      safeQuery(getReserveMargins, "STPASA"),
    ]);

    return NextResponse.json({ generation, constraints, fcas, bidstack, rooftoppv, reserves }, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error("Analytics API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
