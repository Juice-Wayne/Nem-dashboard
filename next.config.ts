import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure the committed revenue archive JSONs are bundled into serverless functions
  // on Vercel (they're read via fs.readFile from the /api/revenue route at runtime).
  outputFileTracingIncludes: {
    "/api/revenue": ["./data/revenue/**/*.json"],
  },
};

export default nextConfig;
