// lib/offloading/math.ts

export interface OffloadConfig {
  /** ISO timestamp for the first HH ending (e.g. "2025-07-01T13:00:00"). */
  startISO: string;
  /** Event length in hours (integer, 4–12). */
  durationHrs: number;
  /** Target total MW reduction across the whole event (spread evenly across HHs). */
  mwReduction: number;
  /** Unit 1 registered capacity in MW. */
  lyb1Cap: number;
  /** Unit 2 registered capacity in MW. */
  lyb2Cap: number;
}

/** One half-hour row in the offloading table. */
export interface ScheduleRow {
  hhEnding: string;           // ISO timestamp
  targetOffloadMW: number;    // constant MWh_reduction / durationHrs
  lyb1TargetMW: number;       // lyb1Cap - targetOffload/2 (editable by user)
  lyb2TargetMW: number;       // lyb2Cap - targetOffload/2 (editable by user)
  forecastMW: number;         // lyb1TargetMW + lyb2TargetMW
}

/** Overrides for a single row. Undefined fields fall back to defaults / AEMO. */
export interface RowOverrides {
  lyb1TargetMW?: number;
  lyb2TargetMW?: number;
  actualMW?: number;
}

/** Row after actuals and overrides are applied. */
export interface ComputedRow extends ScheduleRow {
  actualMW: number | null;     // AEMO value (or override); null if neither available
  mwLoss: number;              // totalCap - (actualMW ?? forecastMW)
  mwhThisHH: number;           // mwLoss / 2
  cumMWh: number;              // running sum of mwhThisHH through this row
  // Which fields came from user overrides (for UI marking).
  overridden: { lyb1TargetMW: boolean; lyb2TargetMW: boolean; actualMW: boolean };
}

/** Number of half-hour rows in the event. */
export function rowCount(config: OffloadConfig): number {
  return Math.round(config.durationHrs * 2);
}

/** Total station capacity. */
export function totalCap(config: OffloadConfig): number {
  return config.lyb1Cap + config.lyb2Cap;
}

/** Offload rate per HH: total MW reduction divided by the event duration. */
export function offloadRate(config: OffloadConfig): number {
  return config.mwReduction / config.durationHrs;
}

/**
 * Build the base schedule — no actuals, no overrides.
 * Each row represents a half-hour block labeled by its ending timestamp.
 */
export function buildSchedule(config: OffloadConfig): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const start = new Date(config.startISO).getTime();
  const rate = offloadRate(config);
  // Clamp at zero — a unit can't run at negative MW. If the event demands
  // more offload than a unit's capacity, the target bottoms out at shut-down (0).
  const lyb1Target = Math.max(0, config.lyb1Cap - rate / 2);
  const lyb2Target = Math.max(0, config.lyb2Cap - rate / 2);
  for (let i = 0; i < rowCount(config); i++) {
    const hhEndMs = start + (i + 1) * 30 * 60 * 1000;
    rows.push({
      hhEnding: new Date(hhEndMs).toISOString(),
      targetOffloadMW: rate,
      lyb1TargetMW: lyb1Target,
      lyb2TargetMW: lyb2Target,
      forecastMW: lyb1Target + lyb2Target,
    });
  }
  return rows;
}

/** Map from HH-ending ISO timestamp → actual MW at the station (LYB1+LYB2 summed, 30-min avg). */
export type ActualsByHH = Map<string, number>;

/** Map from HH-ending ISO timestamp → per-row user overrides. */
export type OverridesByHH = Map<string, RowOverrides>;

/**
 * Apply AEMO actuals and user overrides to the schedule.
 * Override precedence: user override > AEMO value > null.
 * Cumulative MWh always uses the effective actual (override > AEMO > forecast fallback).
 */
export function applyActuals(
  schedule: ScheduleRow[],
  actuals: ActualsByHH,
  overrides: OverridesByHH,
  config: OffloadConfig,
): ComputedRow[] {
  const cap = totalCap(config);
  const result: ComputedRow[] = [];
  let cumMWh = 0;
  for (const row of schedule) {
    const ov = overrides.get(row.hhEnding) ?? {};
    const aemoActual = actuals.get(row.hhEnding);
    const effectiveLyb1Target = ov.lyb1TargetMW ?? row.lyb1TargetMW;
    const effectiveLyb2Target = ov.lyb2TargetMW ?? row.lyb2TargetMW;
    const effectiveForecast = effectiveLyb1Target + effectiveLyb2Target;
    const actualMW = ov.actualMW ?? aemoActual ?? null;
    // Fall back to forecast so cumulative MWh projects forward before AEMO data arrives.
    const basisMW = actualMW ?? effectiveForecast;
    const mwLoss = cap - basisMW;
    const mwhThisHH = mwLoss / 2;
    cumMWh += mwhThisHH;
    result.push({
      ...row,
      lyb1TargetMW: effectiveLyb1Target,
      lyb2TargetMW: effectiveLyb2Target,
      forecastMW: effectiveForecast,
      actualMW,
      mwLoss,
      mwhThisHH,
      cumMWh,
      overridden: {
        lyb1TargetMW: ov.lyb1TargetMW !== undefined,
        lyb2TargetMW: ov.lyb2TargetMW !== undefined,
        actualMW: ov.actualMW !== undefined,
      },
    });
  }
  return result;
}

/** Progress state for the bottom-of-table bar. */
export type ProgressState = "onTrack" | "behind" | "over";

export function progressState(rows: ComputedRow[], config: OffloadConfig, nowMs = Date.now()): ProgressState {
  const cumTotal = rows[rows.length - 1]?.cumMWh ?? 0;
  if (cumTotal > config.mwReduction * 1.1) return "over";
  // Linear target: expected MWh by this point in time.
  const startMs = new Date(config.startISO).getTime();
  const elapsedHrs = Math.max(0, (nowMs - startMs) / 3_600_000);
  if (elapsedHrs >= config.durationHrs) return cumTotal >= config.mwReduction * 0.9 ? "onTrack" : "behind";
  const target = (config.mwReduction / config.durationHrs) * elapsedHrs;
  if (cumTotal < target * 0.9) return "behind";
  return "onTrack";
}
