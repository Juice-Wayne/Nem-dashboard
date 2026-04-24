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
  targetOffloadMW: number;    // constant MW per HH (mwReduction / durationHrs)
  targetCumMWh: number;       // running target: -(i+1) * targetOffloadMW/2 (negative)
  lyb1TargetMW: number;       // lyb1Cap - targetOffload/2
  lyb2TargetMW: number;       // lyb2Cap - targetOffload/2
  forecastMW: number;         // lyb1TargetMW + lyb2TargetMW
}

/** Per-HH user overrides. All fields optional — undefined means "use AEMO / default". */
export interface RowOverrides {
  lyb1Actual?: number;
  lyb2Actual?: number;
  lyb1Gas?: number;
  lyb2Gas?: number;
}

/** Row after actuals + overrides applied. */
export interface ComputedRow extends ScheduleRow {
  // Per-unit actuals (AEMO or user override). null if neither available.
  lyb1Actual: number | null;
  lyb2Actual: number | null;
  // Gas MW used per unit (user entry only, default 0).
  lyb1Gas: number;
  lyb2Gas: number;
  /** Total station actual after subtracting gas usage. null if either unit actual is missing. */
  totalActualMW: number | null;
  /** Capacity - (totalActualMW ?? forecastMW). */
  mwLoss: number;
  /** mwLoss / 2. */
  mwhThisHH: number;
  /** Running sum of mwhThisHH through this row. */
  cumMWh: number;
  overridden: {
    lyb1Actual: boolean;
    lyb2Actual: boolean;
    lyb1Gas: boolean;
    lyb2Gas: boolean;
  };
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

/** Build the base schedule — no actuals, no overrides. */
export function buildSchedule(config: OffloadConfig): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const start = new Date(config.startISO).getTime();
  const rate = offloadRate(config);
  // Clamp at zero — a unit can't run at negative MW.
  const lyb1Target = Math.max(0, config.lyb1Cap - rate / 2);
  const lyb2Target = Math.max(0, config.lyb2Cap - rate / 2);
  for (let i = 0; i < rowCount(config); i++) {
    const hhEndMs = start + (i + 1) * 30 * 60 * 1000;
    rows.push({
      hhEnding: new Date(hhEndMs).toISOString(),
      targetOffloadMW: rate,
      targetCumMWh: -((i + 1) * rate / 2),  // -200, -400, -600, ...
      lyb1TargetMW: lyb1Target,
      lyb2TargetMW: lyb2Target,
      forecastMW: lyb1Target + lyb2Target,
    });
  }
  return rows;
}

/** Per-HH AEMO actual MW split by unit. */
export type ActualsByHH = Map<string, { lyb1: number; lyb2: number }>;

/** Per-HH user overrides. */
export type OverridesByHH = Map<string, RowOverrides>;

/** Apply AEMO actuals + user overrides to a schedule. */
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
    const aemo = actuals.get(row.hhEnding);

    const lyb1Actual = ov.lyb1Actual ?? aemo?.lyb1 ?? null;
    const lyb2Actual = ov.lyb2Actual ?? aemo?.lyb2 ?? null;
    const lyb1Gas = ov.lyb1Gas ?? 0;
    const lyb2Gas = ov.lyb2Gas ?? 0;

    // Total available only when both units have an actual reading.
    const totalActualMW =
      lyb1Actual != null && lyb2Actual != null
        ? lyb1Actual - lyb1Gas + lyb2Actual - lyb2Gas
        : null;

    // Fall back to forecast so cumulative MWh projects forward before AEMO data arrives.
    const basisMW = totalActualMW ?? row.forecastMW;
    const mwLoss = cap - basisMW;
    const mwhThisHH = mwLoss / 2;
    cumMWh += mwhThisHH;

    result.push({
      ...row,
      lyb1Actual,
      lyb2Actual,
      lyb1Gas,
      lyb2Gas,
      totalActualMW,
      mwLoss,
      mwhThisHH,
      cumMWh,
      overridden: {
        lyb1Actual: ov.lyb1Actual !== undefined,
        lyb2Actual: ov.lyb2Actual !== undefined,
        lyb1Gas: ov.lyb1Gas !== undefined,
        lyb2Gas: ov.lyb2Gas !== undefined,
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
  const startMs = new Date(config.startISO).getTime();
  const elapsedHrs = Math.max(0, (nowMs - startMs) / 3_600_000);
  if (elapsedHrs >= config.durationHrs) return cumTotal >= config.mwReduction * 0.9 ? "onTrack" : "behind";
  const target = (config.mwReduction / config.durationHrs) * elapsedHrs;
  if (cumTotal < target * 0.9) return "behind";
  return "onTrack";
}
