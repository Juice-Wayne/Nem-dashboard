import { NextResponse } from "next/server";
import { getWEMMarketSummary } from "@/lib/wem";

export async function GET() {
  try {
    const data = await getWEMMarketSummary();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    console.error("WEM market API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
