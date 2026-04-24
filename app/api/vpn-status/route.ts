import { NextResponse } from "next/server";
import os from "os";

// Trusted subnets: company VPN (10.121.x.x) and office LAN (10.34.x.x).
// Override via TRUSTED_SUBNETS env var (comma-separated prefixes, e.g. "10.121.,10.34.").
const TRUSTED_SUBNETS = process.env.TRUSTED_SUBNETS?.split(",").map((s) => s.trim()).filter(Boolean)
  ?? ["10.121.", "10.34."];

export async function GET() {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && TRUSTED_SUBNETS.some((p) => addr.address.startsWith(p))) {
        return NextResponse.json({ vpn: true });
      }
    }
  }
  return NextResponse.json({ vpn: false }, { status: 403 });
}
