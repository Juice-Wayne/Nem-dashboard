import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// Password is case-insensitive. Override via ACCESS_PASSWORD env var on Vercel.
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD ?? "power").toLowerCase();
const COOKIE_NAME = "nem-auth";
const TOKEN = crypto.createHash("sha256").update(ACCESS_PASSWORD).digest("hex");
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const submitted = form.get("password");

  if (typeof submitted !== "string" || submitted.trim().toLowerCase() !== ACCESS_PASSWORD) {
    return NextResponse.redirect(new URL("/?e=1", request.url), { status: 303 });
  }

  const res = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  res.cookies.set(COOKIE_NAME, TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return res;
}
