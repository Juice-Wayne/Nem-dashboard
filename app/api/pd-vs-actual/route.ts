import { NextResponse } from "next/server";

import {
  getP5MinVsActualPrices,
  getP5MinVsActualDemand,
  getP5MinVsActualInterconnectors,
} from "@/lib/nemweb";

async function safeQuery<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[pd-vs-actual] ${label} query failed:`, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function GET() {
  try {
    const [prices, demand, interconnectors] = await Promise.all([
      safeQuery(getP5MinVsActualPrices, "prices"),
      safeQuery(getP5MinVsActualDemand, "demand"),
      safeQuery(getP5MinVsActualInterconnectors, "interconnectors"),
    ]);

    return NextResponse.json(
      { prices, demand, interconnectors },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    console.error("PD vs Actual API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
