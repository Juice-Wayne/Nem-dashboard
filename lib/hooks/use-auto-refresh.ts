import { useEffect, useRef } from "react";
import useSWR, { type SWRConfiguration } from "swr";

const OFFSET_SECONDS = 45; // seconds past each 5-min mark
const INTERVAL_MINUTES = 5;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(data.error);
  }
  return data;
};

/** Ms until the next 5-minute boundary + 45 seconds */
function msUntilNextTick(): number {
  const now = new Date();
  const mins = now.getMinutes();
  const secs = now.getSeconds();
  const ms = now.getMilliseconds();

  // Current position in seconds within the current 5-min block
  const blockMin = mins % INTERVAL_MINUTES;
  const currentSecs = blockMin * 60 + secs;
  const targetSecs = OFFSET_SECONDS; // 0 minutes + 45 seconds into the block

  let deltaSecs = targetSecs - currentSecs;
  if (deltaSecs <= 0) {
    // Already past the target in this block, schedule for the next one
    deltaSecs += INTERVAL_MINUTES * 60;
  }

  return deltaSecs * 1000 - ms;
}

export function useAutoRefresh<T>(
  url: string | null,
  options?: SWRConfiguration,
) {
  const result = useSWR<T>(url, fetcher, {
    revalidateOnFocus: false,
    ...options,
  });

  const mutateRef = useRef(result.mutate);
  mutateRef.current = result.mutate;

  useEffect(() => {
    if (!url) return;

    let timer: ReturnType<typeof setTimeout>;

    function schedule() {
      const delay = msUntilNextTick();
      timer = setTimeout(() => {
        mutateRef.current();
        schedule();
      }, delay);
    }

    schedule();
    return () => clearTimeout(timer);
  }, [url]);

  return result;
}
