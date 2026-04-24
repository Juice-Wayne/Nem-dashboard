import { NextRequest, NextResponse } from "next/server";

// Password is case-insensitive. Override via ACCESS_PASSWORD env var on Vercel.
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD ?? "power").toLowerCase();
const COOKIE_NAME = "nem-auth";
const LOCALHOST = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Edge runtime uses Web Crypto — compute once per boot, cache the promise.
let tokenPromise: Promise<string> | null = null;
function getExpectedToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const data = new TextEncoder().encode(ACCESS_PASSWORD);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    })();
  }
  return tokenPromise;
}

function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "127.0.0.1";
}

function loginHtml(error: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEM Dashboard</title>
</head>
<body style="background:#0a0a0a;color:#a1a1aa;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <form method="POST" action="/api/auth" style="display:flex;flex-direction:column;gap:10px;min-width:260px">
    <h1 style="color:#f4f4f5;font-size:1.25rem;margin:0 0 6px;text-align:center">NEM Dashboard</h1>
    <input type="password" name="password" autofocus required placeholder="Password" autocomplete="current-password"
      style="background:#18181b;border:1px solid #3f3f46;color:#f4f4f5;padding:10px 12px;border-radius:6px;font-size:0.95rem;outline:none" />
    <button type="submit"
      style="background:#f4f4f5;color:#0a0a0a;border:0;padding:10px 12px;border-radius:6px;font-weight:500;cursor:pointer;font-size:0.9rem">
      Enter
    </button>
    ${error ? '<p style="color:#f87171;font-size:0.8rem;margin:2px 0 0;text-align:center">Incorrect password</p>' : ''}
  </form>
</body>
</html>`;
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Always allow static assets and the auth endpoint.
  if (
    path === "/favicon.ico" ||
    path === "/icon.svg" ||
    path.startsWith("/_next/") ||
    path === "/api/auth"
  ) {
    return NextResponse.next();
  }

  // Localhost bypass — dev convenience.
  const ip = getClientIp(request);
  if (LOCALHOST.has(ip)) return NextResponse.next();

  const cookieToken = request.cookies.get(COOKIE_NAME)?.value;
  const expected = await getExpectedToken();
  if (cookieToken && cookieToken === expected) {
    return NextResponse.next();
  }

  const error = request.nextUrl.searchParams.get("e") === "1";
  return new NextResponse(loginHtml(error), {
    status: 401,
    headers: { "Content-Type": "text/html" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
