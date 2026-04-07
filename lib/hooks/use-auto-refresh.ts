import { useEffect, useRef, useState, useCallback } from "react";
import useSWR, { type SWRConfiguration } from "swr";

const INTERVAL_MINUTES = 5;

// Aggressive polling to catch AEMO files as soon as they land:
//   DispatchIS publishes ~12-17s after boundary → poll every 3s from +10 to +25
//   P5MIN publishes ~60-140s after boundary → poll every 5s from +55 to +160
//   Fallback: poll every 30s to catch anything missed
const TICK_OFFSETS = [
  // Wave 1: catch DispatchIS actuals (~15s after boundary)
  10, 14, 18, 22, 26,
  // Wave 2: catch P5MIN forecasts (~60-140s after boundary)
  55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 155,
  // Wave 3: fallback to catch stragglers
  180, 220, 270,
];

const forceFetcher = async (url: string) => {
  const separator = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${separator}force=1`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(data.error);
  }
  return data;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(data.error);
  }
  return data;
};

/** Ms until the next 5-minute boundary + offsetSeconds */
function msUntilNextOffset(offsetSeconds: number): number {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();

  const blockMin = mins % INTERVAL_MINUTES;
  const currentSecs = blockMin * 60 + secs;

  let deltaSecs = offsetSeconds - currentSecs;
  if (deltaSecs <= 0) {
    deltaSecs += INTERVAL_MINUTES * 60;
  }

  return deltaSecs * 1000 - ms;
}

export function useAutoRefresh<T>(
  url: string | null,
  options?: SWRConfiguration,
) {
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const result = useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    onSuccess: () => setLastRefreshedAt(new Date()),
    ...options,
  });

  const mutateRef = useRef(result.mutate);
  mutateRef.current = result.mutate;

  const urlRef = useRef(url);
  urlRef.current = url;

  // Scheduled polling — uses forceFetcher to bust server caches on each tick
  // so new AEMO files are picked up immediately
  useEffect(() => {
    if (!url) return;

    const timers: ReturnType<typeof setTimeout>[] = [];

    function scheduleAll() {
      timers.forEach(clearTimeout);
      timers.length = 0;

      for (const offset of TICK_OFFSETS) {
        const delay = msUntilNextOffset(offset);
        const t = setTimeout(async () => {
          if (!urlRef.current) return;
          try {
            const data = await forceFetcher(urlRef.current);
            mutateRef.current(data, { revalidate: false });
          } catch {
            // silently retry on next tick
          }
          if (offset === TICK_OFFSETS[TICK_OFFSETS.length - 1]) {
            scheduleAll();
          }
        }, delay);
        timers.push(t);
      }
    }

    scheduleAll();
    return () => timers.forEach(clearTimeout);
  }, [url]);

  const manualRefresh = useCallback(async () => {
    if (!urlRef.current) return;
    const data = await forceFetcher(urlRef.current);
    result.mutate(data, { revalidate: false });
  }, [result]);

  return { ...result, manualRefresh, lastRefreshedAt };
}
