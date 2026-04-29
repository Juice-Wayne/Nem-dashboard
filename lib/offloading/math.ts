// lib/offloading/math.ts

/** All schedule rows are 5-min ending intervals to match AEMO dispatch cadence. */
export const INTERVAL_MIN = 5;

export interface OffloadConfig {
  /** ISO timestamp for the first 5-min interval ending. */
  startISO: string;
  /** Event length in hours (integer, 1–24). */
  durationHrs: number;
  /** Target total MWh reduction across the whole event. */
  mwReduction: number;
  /** Unit 1 registered capacity in MW. */
  lyb1Cap: number;
  /** Unit 2 registered capacity in MW. */
  lyb2Cap: number;
}

/** One 5-min row in the offloading table — pre-computed (no actuals applied yet). */
export interface ScheduleRow {
  intervalEnding: string;     // ISO timestamp
  /** Target cumulative MWh reduction by end of this interval (negative — running deficit target). */
  targetCumMWh: number;
}

/** Row after AEMO actuals applied + dynamic target computed. */
export interface ComputedRow extends ScheduleRow {
  /** Dynamic MW target for this 5-min interval (catch-up redistributes overshoot/undershoot). */
  targetOffloadMW: number;
  /** Bid target per unit for this row, clamped >= 0. */
  lyb1TargetMW: number;
  lyb2TargetMW: number;
  /** Sum of bid targets — what the station should produce in this interval. */
  forecastMW: number;
  /** AEMO actuals when both units have a reading; null otherwise. */
  lyb1Actual: number | null;
  lyb2Actual: number | null;
  /** Sum of unit actuals (no gas subtraction). null if either unit missing. */
  totalActualMW: number | null;
  /** cap - basisMW where basis is totalActualMW ?? forecastMW. */
  mwLoss: number;
  /** mwLoss * (INTERVAL_MIN / 60). */
  mwhThisInterval: number;
  /** Running sum of mwhThisInterval through this row. */
  cumMWh: number;
}

/** Per-interval AEMO actual MW split by unit. Map key is the intervalEnding ISO. */
export type ActualsByInterval = Map<string, { lyb1: number; lyb2: number }>;

/** Number of 5-min rows in the event. */
export function rowCount(config: OffloadConfig): number {
  return Math.round(config.durationHrs * (60 / INTERVAL_MIN));
}

/** Total station capacity. */
export function totalCap(config: OffloadConfig): number {
  return config.lyb1Cap + config.lyb2Cap;
}

/** Initial offload rate per row (MW). Equals mwReduction / durationHrs because cum delivered = 0. */
export function offloadRate(config: OffloadConfig): number {
  return config.mwReduction / config.durationHrs;
}

/** Build the bare timeline — no actuals, no targets yet. */
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

/** Apply AEMO actuals + recompute the dynamic target per row.
 *  For each row: target = (mwReduction - cumDeliveredBefore) / remainingHours.
 *  Last row uses target = remainingMWh / (INTERVAL_MIN/60). Target is clamped to [0, totalCap]. */
export function applyActuals(
  schedule: ScheduleRow[],
  actuals: ActualsByInterval,
  config: OffloadConfig,
): ComputedRow[] {
  const cap = totalCap(config);
  const result: ComputedRow[] = [];
  const intervalHours = INTERVAL_MIN / 60;
  let cumMWh = 0;

  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];
    const aemo = actuals.get(row.intervalEnding);

    const remainingHours = (schedule.length - i) * intervalHours;
    const remainingMWh = config.mwReduction - cumMWh;
    const rawTarget = remainingMWh / remainingHours;
    const targetOffloadMW = Math.max(0, Math.min(cap, rawTarget));

    const lyb1Target = Math.max(0, config.lyb1Cap - targetOffloadMW / 2);
    const lyb2Target = Math.max(0, config.lyb2Cap - targetOffloadMW / 2);
    const forecastMW = lyb1Target + lyb2Target;

    const lyb1Actual = aemo?.lyb1 ?? null;
    const lyb2Actual = aemo?.lyb2 ?? null;
    const totalActualMW =
      lyb1Actual != null && lyb2Actual != null ? lyb1Actual + lyb2Actual : null;

    const basisMW = totalActualMW ?? forecastMW;
    const mwLoss = cap - basisMW;
    const mwhThisInterval = mwLoss * intervalHours;
    cumMWh += mwhThisInterval;

    result.push({
      ...row,
      targetOffloadMW,
      lyb1TargetMW: lyb1Target,
      lyb2TargetMW: lyb2Target,
      forecastMW,
      lyb1Actual,
      lyb2Actual,
      totalActualMW,
      mwLoss,
      mwhThisInterval,
      cumMWh,
    });
  }
  return result;
}
