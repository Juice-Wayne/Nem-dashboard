"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { priceColor } from "@/lib/format";

function formatPrice(value: number): string {
  return value.toFixed(2);
}

const INTERVAL_SECONDS = 5 * 60;
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000; // UTC+10

interface RegionPrice {
  id: string;
  short: string;
  price: number | null;
}

interface NemIntervalBarProps {
  regionPrices: RegionPrice[];
  lastRefreshedAt: Date | null;
}

function nowAEST(): { hours: number; minutes: number; seconds: number } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const aest = new Date(utcMs + AEST_OFFSET_MS);
  return { hours: aest.getHours(), minutes: aest.getMinutes(), seconds: aest.getSeconds() };
}

export function nowAESTDate(): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utcMs + AEST_OFFSET_MS);
}

function getSecondsIntoBlock(): number {
  const { minutes, seconds } = nowAEST();
  const blockMin = minutes % 5;
  return blockMin * 60 + seconds;
}

function getBarColor(remainingPct: number): string {
  // Smooth HSL: green (120°) → yellow (60°) → orange (30°) → rose (0°)
  const hue = Math.round((remainingPct / 100) * 120);
  return `hsl(${hue}, 80%, 50%)`;
}

function isRainbowMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("rainbow");
}

export function isDataStale(dataInterval: string | null): boolean {
  if (!dataInterval) return false;
  const dataDate = new Date(dataInterval);
  if (isNaN(dataDate.getTime())) return false;

  const aest = nowAESTDate();
  const mins = aest.getMinutes();
  const nextBoundary = 5 - (mins % 5);
  const currentIntervalEnd = new Date(aest);
  currentIntervalEnd.setMinutes(mins + nextBoundary, 0, 0);

  return dataDate < currentIntervalEnd;
}


export function NemIntervalBar({
  regionPrices,
  lastRefreshedAt,
}: NemIntervalBarProps) {
  const [secondsIntoBlock, setSecondsIntoBlock] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [rainbow, setRainbow] = useState(false);

  useEffect(() => {
    setMounted(true);
    setSecondsIntoBlock(getSecondsIntoBlock());
    setRainbow(isRainbowMode());
    const timer = setInterval(() => {
      setSecondsIntoBlock(getSecondsIntoBlock());
      setRainbow(isRainbowMode());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsRemaining = INTERVAL_SECONDS - secondsIntoBlock;
  const remainingPct = (secondsRemaining / INTERVAL_SECONDS) * 100;

  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  const countdown = `${mins}:${secs.toString().padStart(2, "0")}`;

  // Current NEM interval-ending time in AEST
  const aest = nowAEST();
  const nextBoundary = 5 - (aest.minutes % 5);
  const aestNow = nowAESTDate();
  aestNow.setMinutes(aest.minutes + nextBoundary, 0, 0);
  const intervalLabel = aestNow.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const barStyle: React.CSSProperties = rainbow
    ? {
        width: `${remainingPct}%`,
        background: "linear-gradient(90deg, #f43f5e, #f59e0b, #10b981, #3b82f6, #a855f7)",
        backgroundSize: "200% 100%",
        animation: "rainbow-bar-shift 3s linear infinite",
        transition: "width 1s linear",
      }
    : {
        width: `${remainingPct}%`,
        backgroundColor: getBarColor(remainingPct),
        transition: "width 1s linear",
      };

  if (!mounted) return <div className="min-w-[280px]" />;

  return (
    <div className="flex flex-col items-center gap-1 min-w-[280px]">
      {/* Progress bar row */}
      <div className="flex items-center gap-2 w-full">
        <span className="text-[10px] text-zinc-500 tabular-nums whitespace-nowrap" title="Current NEM interval-ending (AEST)">
          {intervalLabel}
        </span>
        <div className="relative flex-1 h-2.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="absolute inset-y-0 right-0 rounded-full"
            style={barStyle}
          />
        </div>
        <span className="text-[10px] tabular-nums text-zinc-500 whitespace-nowrap">
          {countdown}
        </span>
      </div>

      {/* Region prices row — full width, evenly spaced */}
      <div className="flex items-center justify-between w-full">
        {regionPrices.map((rp) => (
          <span key={rp.id} className="inline-flex items-baseline gap-0.5">
            <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
              {rp.short}
            </span>
            <span
              className={cn(
                "text-[11px] tabular-nums font-medium",
                rp.price != null ? priceColor(rp.price) : "text-zinc-600",
              )}
            >
              {rp.price != null ? formatPrice(rp.price) : "-"}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
