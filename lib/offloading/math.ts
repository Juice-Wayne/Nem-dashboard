// lib/offloading/math.ts

/** All schedule rows are 5-min ending intervals to match AEMO dispatch cadence. */
export const INTERVAL_MIN = 5;

/**
 * Snap an instant to a 5-min interval boundary, returning an AEST-wall-clock-as-Z
 * ISO string (matches AEMO's SETTLEMENTDATE-as-Z convention used everywhere else
 * in this module). Numeric input is interpreted as real-UTC ms and shifted to
 * AEST. String input is parsed by parts so it never picks up a host TZ offset.
 */
export function snapToInterval(t: number | Date | string, mode: "ceil" | "floor" = "ceil"): string {
  const stepMs = INTERVAL_MIN * 60 * 1000;
  const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
  let ms: number;
  if (typeof t === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?$/.exec(t);
    if (m) {
      ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    } else {
      ms = new Date(t).getTime() + AEST_OFFSET_MS;
    }
  } else if (typeof t === "number") {
    ms = t + AEST_OFFSET_MS;
  } else {
    ms = t.getTime() + AEST_OFFSET_MS;
  }
  const fn = mode === "ceil" ? Math.ceil : Math.floor;
  return new Date(fn(ms / stepMs) * stepMs).toISOString();
}

export interface OffloadConfig {
  /** ISO timestamp for the first 5-min interval ending. */
  startISO: string;
  /** Event length in hours. */
  durationHrs: number;
  /** Total MWh reduction across the event (uniformly spread across intervals). */
  mwReduction: number;
  /** Unit 1 registered capacity in MW. */
  lyb1Cap: number;
  /** Unit 2 registered capacity in MW. */
  lyb2Cap: number;
  /** Unit 1 ramp rate in MW/min. */
  lyb1RampRate: number;
  /** Unit 2 ramp rate in MW/min. */
  lyb2RampRate: number;
  /** Pre-offload target MW LYB1 will be running at entering the event. Used as ramp anchor. */
  lyb1PreOffload: number;
  /** Pre-offload target MW LYB2 will be running at entering the event. */
  lyb2PreOffload: number;
  /** Extra MWh of reduction to deliver above `mwReduction` as a safety margin. */
  bufferMW: number;
}

/** Pre-computed timeline (no PD, no targets yet). */
export interface ScheduleRow {
  intervalEnding: string;
  /** Target cumulative MWh reduction by end of this interval (negative running total). */
  targetCumMWh: number;
}

/**
 * Per-interval back-filled actual gen at start of the interval (i.e. SCADA
 * reading at the boundary between the prior and current interval). Pulled
 * automatically from SCADA for past intervals, manually editable.
 */
export type ActualByInterval = Map<string, { lyb1: number | null; lyb2: number | null }>;

export interface ComputedRow extends ScheduleRow {
  /** Actual MW at start of this interval (back-fill, sum of LYB1+LYB2). */
  actualGenStart: number | null;
  actualGenStartLyb1: number | null;
  actualGenStartLyb2: number | null;
  /** Required reduction MW this interval (uniform = mwReduction / durationHrs). */
  reductionMW: number;
  /** Forecast gen MW during offload = totalCap − reductionMW (steady-state). */
  forecastGenTotal: number;
  /** Per-unit ramp-aware end-of-interval bid MW (for forward rows). */
  lyb1BidMW: number | null;
  lyb2BidMW: number | null;
  /** Per-unit linear-ramp avg achieved over interval. Uses actuals where available. */
  lyb1AvgAchievedMW: number | null;
  lyb2AvgAchievedMW: number | null;
  /** MWh reduction delivered this interval = (cap − sum_avgAchieved) × intervalHours. */
  reductionMWhThisInterval: number;
  /** Running sum of reductionMWhThisInterval. */
  cumReductionMWh: number;
  /** True if this row used filled actuals (past), false if it's a forward bid. */
  isActual: boolean;
  /**
   * actualGenStart − forecastGenTotal (sum-of-units MW) for past rows where an
   * actual is filled. Null for rows with no actual data.
   * Positive = unit currently above target (under-reducing — bids tighten ahead).
   * Negative = unit currently below target (over-reducing — bids relax ahead).
   */
  deltaMW: number | null;
}

export function rowCount(config: OffloadConfig): number {
  return Math.round(config.durationHrs * (60 / INTERVAL_MIN));
}

export function totalCap(config: OffloadConfig): number {
  return config.lyb1Cap + config.lyb2Cap;
}

/** Reduction MW per row (uniform across the event). */
export function reductionMW(config: OffloadConfig): number {
  return config.mwReduction / config.durationHrs;
}

/** Build the bare timeline (timestamps + uniform target cum MWh). */
export function buildSchedule(config: OffloadConfig): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const start = new Date(config.startISO).getTime();
  const stepMs = INTERVAL_MIN * 60 * 1000;
  const ratePerHour = config.mwReduction / config.durationHrs;
  const mwhPerInterval = ratePerHour * (INTERVAL_MIN / 60);
  const n = rowCount(config);
  for (let i = 0; i < n; i++) {
    rows.push({
      intervalEnding: new Date(start + i * stepMs).toISOString(),
      targetCumMWh: -((i + 1) * mwhPerInterval),
    });
  }
  return rows;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute the bid trajectory and per-row reduction tracking.
 *
 * The bid column is a *recommendation* the operator submits to AEMO. It always
 * ramps from `lyb{1,2}PreOffload` toward the steady-state per-unit target X,
 * respecting `lyb{1,2}RampRate × INTERVAL_MIN` per row and the unit cap. X is
 * chosen (binary search) so the *expected* total delivered MWh over the event
 * equals `mwReduction`, where "expected" uses actuals where available and bids
 * elsewhere. So if past actuals diverge from plan, X re-solves to nudge the
 * remaining bids to hit the cumulative target.
 *
 * Past rows are those where `actualByInterval` has both start AND end values
 * (start = actualStart[i], end = actualStart[i+1]). On past rows the cum-MWh
 * uses the actual avg = (start + end) / 2; on forward rows it uses the bid
 * avg = (prevBid + bid) / 2.
 *
 * `deltaMW` reports actualGenStart_total − forecastGenTotal for rows where an
 * actual exists. Positive means the unit is above target (under-reducing).
 *
 * Buffer is applied as `bid = X − bufferMW/2` after the search resolves X, so
 * the buffer over-delivers by ≈ bufferMW × duration MWh.
 */
export function computeRows(
  config: OffloadConfig,
  actualByInterval: ActualByInterval,
): ComputedRow[] {
  const schedule = buildSchedule(config);
  const intervalHours = INTERVAL_MIN / 60;
  const reductionPerRow = reductionMW(config);
  const cap = totalCap(config);
  const forecastGenTotal = cap - reductionPerRow;

  const X = solveBidTarget(schedule, actualByInterval, config);
  const target = X;
  const lyb1RampMW = config.lyb1RampRate * INTERVAL_MIN;
  const lyb2RampMW = config.lyb2RampRate * INTERVAL_MIN;

  let prevBid1 = config.lyb1PreOffload;
  let prevBid2 = config.lyb2PreOffload;
  let cumMWh = 0;

  return schedule.map((row, i) => {
    // Bid recommendation always ramps from prior bid toward target.
    const lyb1BidMW = clamp(
      clamp(target, prevBid1 - lyb1RampMW, prevBid1 + lyb1RampMW),
      0,
      config.lyb1Cap,
    );
    const lyb2BidMW = clamp(
      clamp(target, prevBid2 - lyb2RampMW, prevBid2 + lyb2RampMW),
      0,
      config.lyb2Cap,
    );

    const a = actualByInterval.get(row.intervalEnding);
    const b = actualByInterval.get(schedule[i + 1]?.intervalEnding ?? "");
    const actualGenStartLyb1 = a?.lyb1 ?? null;
    const actualGenStartLyb2 = a?.lyb2 ?? null;
    const actualGenStart =
      actualGenStartLyb1 != null && actualGenStartLyb2 != null
        ? actualGenStartLyb1 + actualGenStartLyb2
        : null;
    const isActual =
      a?.lyb1 != null && a?.lyb2 != null &&
      b?.lyb1 != null && b?.lyb2 != null;

    let lyb1AvgAchievedMW: number;
    let lyb2AvgAchievedMW: number;
    if (isActual) {
      lyb1AvgAchievedMW = (a!.lyb1! + b!.lyb1!) / 2;
      lyb2AvgAchievedMW = (a!.lyb2! + b!.lyb2!) / 2;
    } else {
      lyb1AvgAchievedMW = (prevBid1 + lyb1BidMW) / 2;
      lyb2AvgAchievedMW = (prevBid2 + lyb2BidMW) / 2;
    }

    const reductionMWhThisInterval =
      (cap - (lyb1AvgAchievedMW + lyb2AvgAchievedMW)) * intervalHours;
    cumMWh += reductionMWhThisInterval;

    const deltaMW = actualGenStart != null ? actualGenStart - forecastGenTotal : null;

    prevBid1 = lyb1BidMW;
    prevBid2 = lyb2BidMW;

    return {
      ...row,
      actualGenStart,
      actualGenStartLyb1,
      actualGenStartLyb2,
      reductionMW: reductionPerRow,
      forecastGenTotal,
      lyb1BidMW,
      lyb2BidMW,
      lyb1AvgAchievedMW,
      lyb2AvgAchievedMW,
      reductionMWhThisInterval,
      cumReductionMWh: cumMWh,
      isActual,
      deltaMW,
    };
  });
}

/**
 * Binary-search the per-unit steady-state target X such that simulating the
 * full schedule (bids ramping from pre-offload, with actuals overriding the
 * achieved-avg where available) delivers `mwReduction + bufferMW` MWh — the
 * buffer is the extra MWh of safety margin baked into the search target.
 */
function solveBidTarget(
  schedule: ScheduleRow[],
  actualByInterval: ActualByInterval,
  config: OffloadConfig,
): number {
  const goal = config.mwReduction + (config.bufferMW ?? 0);
  let lo = 0;
  let hi = Math.max(config.lyb1Cap, config.lyb2Cap);
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const delivered = simulateMWh(mid, schedule, actualByInterval, config);
    if (delivered < goal) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function simulateMWh(
  X: number,
  schedule: ScheduleRow[],
  actualByInterval: ActualByInterval,
  config: OffloadConfig,
): number {
  const cap = config.lyb1Cap + config.lyb2Cap;
  const r1 = config.lyb1RampRate * INTERVAL_MIN;
  const r2 = config.lyb2RampRate * INTERVAL_MIN;
  const hr = INTERVAL_MIN / 60;
  let prev1 = config.lyb1PreOffload;
  let prev2 = config.lyb2PreOffload;
  let mw = 0;
  for (let i = 0; i < schedule.length; i++) {
    const bid1 = clamp(clamp(X, prev1 - r1, prev1 + r1), 0, config.lyb1Cap);
    const bid2 = clamp(clamp(X, prev2 - r2, prev2 + r2), 0, config.lyb2Cap);
    const a = actualByInterval.get(schedule[i].intervalEnding);
    const b = actualByInterval.get(schedule[i + 1]?.intervalEnding ?? "");
    let avg1: number;
    let avg2: number;
    if (
      a?.lyb1 != null && a?.lyb2 != null &&
      b?.lyb1 != null && b?.lyb2 != null
    ) {
      avg1 = (a.lyb1 + b.lyb1) / 2;
      avg2 = (a.lyb2 + b.lyb2) / 2;
    } else {
      avg1 = (prev1 + bid1) / 2;
      avg2 = (prev2 + bid2) / 2;
    }
    mw += (cap - avg1 - avg2) * hr;
    prev1 = bid1;
    prev2 = bid2;
  }
  return mw;
}
