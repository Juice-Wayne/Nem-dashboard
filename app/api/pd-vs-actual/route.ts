import { NextRequest, NextResponse } from "next/server";

import {
  getP5MinVsActualPrices,
  getP5MinVsActualDemand,
  getP5MinVsActualInterconnectors,
  clearResultCache,
  clearDirCache,
} from "@/lib/nemweb";

async function safeQuery<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[pd-vs-actual] ${label} query failed:`, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const isForce = request.nextUrl.searchParams.has("force");
    if (isForce) {
      clearResultCache();
      clearDirCache();
    }
    const [prices, demand, interconnectors] = await Promise.all([
      safeQuery(getP5MinVsActualPrices, "prices"),
      safeQuery(getP5MinVsActualDemand, "demand"),
      safeQuery(getP5MinVsActualInterconnectors, "interconnectors"),
    ]);

    return NextResponse.json(
      { prices, demand, interconnectors },
      { headers: isForce ? { "Cache-Control": "no-cache, no-store, must-revalidate" } : { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } },
    );
  } catch (error) {
    console.error("PD vs Actual API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
