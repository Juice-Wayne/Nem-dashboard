/**
 * Verify lib/offloading/math.ts: bids always ramp from pre-offload (respecting
 * ramp limits), Δ = actualGenStart − forecastGenTotal, X solved so total
 * delivered (using actuals where available) equals mwReduction.
 * Run: npx tsx scripts/verify-offloading-math.ts
 */
import {
  buildSchedule,
  computeRows,
  rowCount,
  totalCap,
  reductionMW,
  INTERVAL_MIN,
  type OffloadConfig,
  type ActualByInterval,
} from "../lib/offloading/math";

const config: OffloadConfig = {
  startISO: "2025-07-01T13:00:00.000Z",
  durationHrs: 4,
  mwReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
  lyb1RampRate: 10,
  lyb2RampRate: 10,
  lyb1PreOffload: 585,
  lyb2PreOffload: 585,
  bufferMW: 0,
};

const failures: string[] = [];
function check(label: string, got: number | null, want: number | null, tol = 0.01) {
  const okNull = got == null && want == null;
  const okNum = got != null && want != null && Math.abs(got - want) <= tol;
  if (okNull || okNum) console.log(`  OK ${label} = ${got}`);
  else failures.push(`${label}: got ${got}, want ${want}`);
}

console.log("Constants & helpers...");
check("totalCap", totalCap(config), 1170);
check("reductionMW (uniform)", reductionMW(config), 400);
check("rowCount(4hr)", rowCount(config), 48);

const schedule = buildSchedule(config);
const intervals = schedule.map((r) => r.intervalEnding);

console.log("\nbid trajectory respects ramp from pre-offload (no actuals)...");
const rows0 = computeRows(config, new Map());
// Pre-offload 585, ramp 50, so first bid >= 535. Settles at X (~385) within ramp limit.
check("row0 lyb1Bid >= preOffload − rampMW", rows0[0].lyb1BidMW! >= 535 - 0.01 ? 1 : 0, 1);
check("row1 lyb1Bid step <= rampMW", Math.abs(rows0[1].lyb1BidMW! - rows0[0].lyb1BidMW!) <= 50 + 0.01 ? 1 : 0, 1);
check("settled bid stays flat", Math.abs(rows0[10].lyb1BidMW! - rows0[30].lyb1BidMW!) < 0.5 ? 1 : 0, 1);
check("final cumReductionMWh hits 1600", rows0[47].cumReductionMWh, 1600, 1);

console.log("\nuser-reported case: pre 400/500, ramp 10, no actuals — first bid respects ramp...");
const userCfg: OffloadConfig = { ...config, lyb1PreOffload: 400, lyb2PreOffload: 500 };
const rowsUser = computeRows(userCfg, new Map());
// LYB1 starts at 400, target ≈ 384, ramp ±50 → first bid lands within ramp window.
check("row0 LYB1 bid (target within ramp from 400)", rowsUser[0].lyb1BidMW, 384, 2);
// LYB2 starts at 500, ramp ±50 → first bid clamped to 450.
check("row0 LYB2 bid (ramp clamp from 500)", rowsUser[0].lyb2BidMW, 450, 1);
check("row1 LYB2 bid step from row0 ≤ rampMW", Math.abs(rowsUser[1].lyb2BidMW! - rowsUser[0].lyb2BidMW!) <= 50 + 0.01 ? 1 : 0, 1);

console.log("\ndelta column: actualGenStart − forecastGenTotal...");
const userActuals: ActualByInterval = new Map();
userActuals.set(intervals[0], { lyb1: 381, lyb2: 381 });    // sum = 762
userActuals.set(intervals[1], { lyb1: 424.15, lyb2: 424.15 }); // sum = 848.3
const rowsDelta = computeRows(userCfg, userActuals);
// Row 0 delta = 762 − 770 = −8, NOT +35.1.
check("row0 deltaMW = actualStart − forecast (= -8)", rowsDelta[0].deltaMW, -8, 0.5);
// Row 1 delta = 848.3 − 770 = +78.3.
check("row1 deltaMW (= +78.3)", rowsDelta[1].deltaMW, 78.3, 0.5);
// Forward rows (no actual) → null.
check("row3 deltaMW is null (no actual)", rowsDelta[3].deltaMW, null);

console.log("\nbids ramp from pre-offload even with actuals filled...");
// Bids do NOT take their value from actualEnd. They are the recommendation.
check("row0 LYB2 bid stays at ramp-clamped 450 (actuals don't override bid)", rowsDelta[0].lyb2BidMW, 450, 1);
check("row0 LYB1 bid stays at ramp-converged 384", rowsDelta[0].lyb1BidMW, 384, 2);

console.log("\ncatch-up: under-delivered actuals push bids LOWER (X re-solves)...");
const constantHigh: ActualByInterval = new Map();
for (let i = 0; i < 6; i++) constantHigh.set(intervals[i], { lyb1: 585, lyb2: 585 });
const rowsHigh = computeRows(config, constantHigh);
// Past 5 rows full cap → no reduction delivered there. Forward bids must drop further.
const settledNoCatch = computeRows(config, new Map())[20].lyb1BidMW!;
const settledCatch = rowsHigh[20].lyb1BidMW!;
check("settled bid LOWER under catch-up", settledCatch < settledNoCatch ? 1 : 0, 1);
check("final cumReductionMWh ≈ 1600", rowsHigh[47].cumReductionMWh, 1600, 5);

console.log("\nbuffer 40 MWh → cum delivers 1640 MWh (40 MWh over target)...");
const buffered: OffloadConfig = { ...config, lyb1PreOffload: 400, lyb2PreOffload: 400, bufferMW: 40 };
const finalCum = computeRows(buffered, new Map())[47].cumReductionMWh;
check("final cumReductionMWh ≈ 1600 + 40", finalCum, 1640, 1);

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
