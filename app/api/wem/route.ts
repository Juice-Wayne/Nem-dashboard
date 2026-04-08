import { NextRequest, NextResponse } from "next/server";
import { getWEMPrices, getWEMDemand, getWEMGeneration, getWEMDispatchPriceChanges } from "@/lib/wem";

async function safe<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[wem] ${label} failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" };
const NO_CACHE_HEADERS = { "Cache-Control": "no-cache, no-store, must-revalidate" };

export async function GET(request: NextRequest) {
  try {
    const isForce = request.nextUrl.searchParams.has("force");
    const headers = isForce ? NO_CACHE_HEADERS : CACHE_HEADERS;

    const [prices, demand, generation, dispatchChanges] = await Promise.all([
      safe(getWEMPrices, "prices"),
      safe(getWEMDemand, "demand"),
      safe(getWEMGeneration, "generation"),
      safe(getWEMDispatchPriceChanges, "dispatchChanges"),
    ]);

    return NextResponse.json({ prices, demand, generation, dispatchChanges }, { headers });
  } catch (error) {
    console.error("WEM API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
