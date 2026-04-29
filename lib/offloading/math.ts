// lib/offloading/math.ts

/** All schedule rows are 5-min ending intervals to match AEMO dispatch cadence. */
export const INTERVAL_MIN = 5;

/** Snap an instant to a 5-min interval boundary. Defaults to ceiling (next boundary). */
export function snapToInterval(t: number | Date | string, mode: "ceil" | "floor" = "ceil"): string {
  const ms = typeof t === "number" ? t : new Date(t).getTime();
  const stepMs = INTERVAL_MIN * 60 * 1000;
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
}

/** Pre-computed timeline (no PD, no targets yet). */
export interface ScheduleRow {
  intervalEnding: string;
  /** Target cumulative MWh reduction by end of this interval (negative running total). */
  targetCumMWh: number;
}

/** Per-interval AEMO PD targets per unit. */
export type PDByInterval = Map<string, { lyb1: number | null; lyb2: number | null }>;

export interface ComputedRow extends ScheduleRow {
  pdLyb1: number | null;
  pdLyb2: number | null;
  pdTotal: number | null;
  /** Required reduction MW this interval (uniform = mwReduction / durationHrs). */
  reductionMW: number;
  /** Forecast gen MW during offload = totalCap − reductionMW (constant per row). */
  forecastGenTotal: number;
  /** Per-unit ramp-aware end-of-interval bid MW. null if PD missing for row 0 anchor. */
  lyb1BidMW: number | null;
  lyb2BidMW: number | null;
  /** Per-unit linear-ramp avg achieved over interval = (prevEnd + bid) / 2. */
  lyb1AvgAchievedMW: number | null;
  lyb2AvgAchievedMW: number | null;
  /** MWh reduction delivered this interval vs PD baseline = (pdTotal − sum_avgAchieved) × intervalHours. */
  reductionMWhThisInterval: number;
  /** Running sum of reductionMWhThisInterval. */
  cumReductionMWh: number;
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
 * Compute ramp-aware bid trajectory + delivered reduction.
 *
 * Steady-state offload setpoint per unit is capacity-based:
 *   forecastGenTotal = totalCap − reductionMW                        (constant per row)
 *   forecastGenUnit  = unitCap  − reductionMW / 2                    (constant per row)
 *
 * Each row's bid is the end-of-interval MW driving the unit toward the
 * offload setpoint at full ramp, settling there once reached:
 *   bid = clamp(forecastGenUnit, prevEnd ± rampMW × intervalMin, [0, unitCap])
 *
 * During the ramp-in phase the avg achieved is between prevEnd and the bid,
 * so cumulative delivered MWh will lag the uniform target until the unit
 * reaches the offload setpoint and holds.
 *
 * Row 0 anchors prevEnd at the unit's first non-null PD target (where AEMO
 * predicts the unit was running entering the event). PD targets in later
 * rows are displayed but don't change the trajectory — the unit ramps from
 * row 0's PD anchor toward the steady-state forecastGenUnit, then holds.
 */
export function computeRows(config: OffloadConfig, pdByInterval: PDByInterval): ComputedRow[] {
  const schedule = buildSchedule(config);
  const intervalHours = INTERVAL_MIN / 60;
  const reductionPerRow = reductionMW(config);
  const cap = totalCap(config);
  const forecastGenTotal = cap - reductionPerRow;
  const forecastGenLyb1 = config.lyb1Cap - reductionPerRow / 2;
  const forecastGenLyb2 = config.lyb2Cap - reductionPerRow / 2;

  const lyb1RampMW = config.lyb1RampRate * INTERVAL_MIN;
  const lyb2RampMW = config.lyb2RampRate * INTERVAL_MIN;

  let prevEnd1: number | null = null;
  let prevEnd2: number | null = null;
  let cumMWh = 0;

  return schedule.map((row) => {
    const pd = pdByInterval.get(row.intervalEnding);
    const pdLyb1 = pd?.lyb1 ?? null;
    const pdLyb2 = pd?.lyb2 ?? null;
    const pdTotal = pdLyb1 != null && pdLyb2 != null ? pdLyb1 + pdLyb2 : null;

    if (prevEnd1 == null && pdLyb1 != null) prevEnd1 = pdLyb1;
    if (prevEnd2 == null && pdLyb2 != null) prevEnd2 = pdLyb2;

    const lyb1BidMW = computeBid(prevEnd1, forecastGenLyb1, lyb1RampMW, config.lyb1Cap);
    const lyb2BidMW = computeBid(prevEnd2, forecastGenLyb2, lyb2RampMW, config.lyb2Cap);

    const lyb1AvgAchievedMW = lyb1BidMW != null && prevEnd1 != null ? (prevEnd1 + lyb1BidMW) / 2 : null;
    const lyb2AvgAchievedMW = lyb2BidMW != null && prevEnd2 != null ? (prevEnd2 + lyb2BidMW) / 2 : null;

    let reductionMWhThisInterval = 0;
    if (
      pdTotal != null &&
      lyb1AvgAchievedMW != null &&
      lyb2AvgAchievedMW != null
    ) {
      reductionMWhThisInterval = (pdTotal - (lyb1AvgAchievedMW + lyb2AvgAchievedMW)) * intervalHours;
      cumMWh += reductionMWhThisInterval;
    }

    if (lyb1BidMW != null) prevEnd1 = lyb1BidMW;
    if (lyb2BidMW != null) prevEnd2 = lyb2BidMW;

    return {
      ...row,
      pdLyb1,
      pdLyb2,
      pdTotal,
      reductionMW: reductionPerRow,
      forecastGenTotal,
      lyb1BidMW,
      lyb2BidMW,
      lyb1AvgAchievedMW,
      lyb2AvgAchievedMW,
      reductionMWhThisInterval,
      cumReductionMWh: cumMWh,
    };
  });
}

function computeBid(
  prevEnd: number | null,
  forecastGenUnit: number,
  rampMW: number,
  unitCap: number,
): number | null {
  if (prevEnd == null) return null;
  // Drive the unit toward the offload setpoint as fast as the ramp allows; settle there once reached.
  const rampClamped = clamp(forecastGenUnit, prevEnd - rampMW, prevEnd + rampMW);
  return clamp(rampClamped, 0, unitCap);
}
