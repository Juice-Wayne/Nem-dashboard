import { NextRequest, NextResponse } from "next/server";

// Comma-separated list of allowed public IPs (VPN egress).
// On Vercel: set ALLOWED_IPS=20.53.131.91 in project env vars.
// Locally: localhost is allowed through middleware, but the client calls /api/vpn-status
// which checks if the VPN adapter is actually present on the machine.
const ALLOWED_IPS = process.env.ALLOWED_IPS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const LOCALHOST = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "127.0.0.1";
}

export function middleware(request: NextRequest) {
  if (ALLOWED_IPS.length === 0) return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (path === "/favicon.ico" || path === "/icon.svg" || path.startsWith("/_next/")) {
    return NextResponse.next();
  }

  // Always allow /api/vpn-status so the client-side check can run.
  if (path === "/api/vpn-status") return NextResponse.next();

  const ip = getClientIp(request);

  // Localhost passes middleware — the client-side VPN gate in page.tsx calls
  // /api/vpn-status to verify the VPN adapter is actually up.
  if (LOCALHOST.has(ip)) return NextResponse.next();

  // Production (Vercel) — check against allowed VPN egress IPs.
  if (ALLOWED_IPS.includes(ip)) return NextResponse.next();

  return new NextResponse(
    `<!DOCTYPE html><html><head><title>Access Denied</title></head>
    <body style="background:#0a0a0a;color:#a1a1aa;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h1 style="color:#f4f4f5;font-size:1.5rem;margin-bottom:0.5rem">Network Required</h1>
        <p>Connect from the office or with the company VPN, then refresh.</p>
        <p style="font-size:0.75rem;margin-top:1rem;color:#52525b">Your IP: ${ip}</p>
      </div>
    </body></html>`,
    { status: 403, headers: { "Content-Type": "text/html" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
