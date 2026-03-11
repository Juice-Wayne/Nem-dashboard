import { NextRequest, NextResponse } from "next/server";

import {
  getP5MinPriceChanges,
  getPredispatchPriceChanges,
  getP5MinDemandChanges,
  getPredispatchDemandChanges,
  getP5MinInterconnectorChanges,
  getPredispatchInterconnectorChanges,
  getP5MinSensitivityChanges,
  getPredispatchSensitivityChanges,
  clearResultCache,
  clearDirCache,
} from "@/lib/nemweb";

/** Wrap a query so unverified table names return [] instead of crashing */
async function safeQuery<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[pd-changes] ${label} query failed (table may not exist):`, error instanceof Error ? error.message : error);
    return [];
  }
}

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" };

export async function GET(request: NextRequest) {
  try {
    // Force refresh: clear all server-side caches
    if (request.nextUrl.searchParams.has("force")) {
      clearResultCache();
      clearDirCache();
    }

    const type = request.nextUrl.searchParams.get("type");

    // --- All types in parallel (single request for all tabs) ---
    if (type === "all") {
      const [
        pricesP5, pricesPD,
        demandP5, demandPD,
        icP5, icPD,
        sensP5, sensPD,
      ] = await Promise.all([
        getP5MinPriceChanges(),
        getPredispatchPriceChanges(),
        getP5MinDemandChanges(),
        getPredispatchDemandChanges(),
        safeQuery(getP5MinInterconnectorChanges, "P5MIN_INTERCONNECTORSOLN"),
        safeQuery(getPredispatchInterconnectorChanges, "PREDISPATCHINTERCONNECTORRES"),
        safeQuery(getP5MinSensitivityChanges, "P5MIN_PRICESENSITIVITIES"),
        safeQuery(getPredispatchSensitivityChanges, "PREDISPATCH_PRICESENSITIVITIES"),
      ]);
      return NextResponse.json({
        prices: { p5min: pricesP5, predispatch: pricesPD },
        demand: { p5min: demandP5, predispatch: demandPD },
        interconnectors: { p5min: icP5, predispatch: icPD },
        sensitivities: { p5min: sensP5, predispatch: sensPD },
      }, { headers: CACHE_HEADERS });
    }

    // --- Prices (existing) ---
    if (!type || type === "prices") {
      const [p5min, predispatch] = await Promise.all([
        getP5MinPriceChanges(),
        getPredispatchPriceChanges(),
      ]);
      return NextResponse.json({ p5min, predispatch }, { headers: CACHE_HEADERS });
    }

    // --- Demand ---
    if (type === "demand") {
      const [p5min, predispatch] = await Promise.all([
        getP5MinDemandChanges(),
        getPredispatchDemandChanges(),
      ]);
      return NextResponse.json({ p5min, predispatch }, { headers: CACHE_HEADERS });
    }

    // --- Interconnectors ---
    if (type === "interconnectors") {
      const [p5min, predispatch] = await Promise.all([
        safeQuery(getP5MinInterconnectorChanges, "P5MIN_INTERCONNECTORSOLN"),
        safeQuery(getPredispatchInterconnectorChanges, "PREDISPATCHINTERCONNECTORRES"),
      ]);
      return NextResponse.json({ p5min, predispatch }, { headers: CACHE_HEADERS });
    }

    // --- Sensitivities ---
    if (type === "sensitivities") {
      const [p5min, predispatch] = await Promise.all([
        safeQuery(getP5MinSensitivityChanges, "P5MIN_PRICESENSITIVITIES"),
        safeQuery(getPredispatchSensitivityChanges, "PREDISPATCH_PRICESENSITIVITIES"),
      ]);
      return NextResponse.json({ p5min, predispatch }, { headers: CACHE_HEADERS });
    }

    // Unknown type — fallback to prices
    const [p5min, predispatch] = await Promise.all([
      getP5MinPriceChanges(),
      getPredispatchPriceChanges(),
    ]);
    return NextResponse.json({ p5min, predispatch }, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error("PD Changes API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
