/**
 * Verify lib/offloading/math.ts behaviour for 5-min rows + dynamic target.
 * Run: npx tsx scripts/verify-offloading-math.ts
 */
import {
  applyActuals,
  buildSchedule,
  offloadRate,
  rowCount,
  totalCap,
  INTERVAL_MIN,
  type ActualsByInterval,
  type OffloadConfig,
} from "../lib/offloading/math";

const config: OffloadConfig = {
  startISO: "2025-07-01T13:00:00.000Z",
  durationHrs: 4,
  mwReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
};

const failures: string[] = [];
function check(label: string, got: number, want: number, tol = 0.01) {
  if (Math.abs(got - want) > tol) failures.push(`${label}: got ${got}, want ${want}`);
  else console.log(`  OK ${label} = ${got}`);
}

console.log("Constants & helpers...");
check("INTERVAL_MIN", INTERVAL_MIN, 5);
check("totalCap", totalCap(config), 1170);
check("offloadRate", offloadRate(config), 400); // 1600 / 4 hrs
check("rowCount(4hr)", rowCount(config), 48); // 4 hrs * 12 intervals/hr

console.log("\nbuildSchedule timeline...");
const schedule = buildSchedule(config);
check("schedule length", schedule.length, 48);
check(
  "row1 step is 5 min after row0",
  new Date(schedule[1].intervalEnding).getTime() -
    new Date(schedule[0].intervalEnding).getTime(),
  5 * 60 * 1000,
);
// targetCumMWh: per-row mwh = 400 MW * (5/60) = 33.333..., negative running sum
check("row0 targetCumMWh", schedule[0].targetCumMWh, -33.333, 0.01);
check("row47 targetCumMWh", schedule[47].targetCumMWh, -1600, 0.01);

console.log("\napplyActuals — no AEMO data (forecast fallback) hits target exactly...");
const noActuals = applyActuals(schedule, new Map(), config);
check("row0 targetOffloadMW", noActuals[0].targetOffloadMW, 400); // 1600 / 4hr
check("row0 lyb1TargetMW", noActuals[0].lyb1TargetMW, 385); // 585 - 200
check("row0 lyb2TargetMW", noActuals[0].lyb2TargetMW, 385);
check("row0 forecastMW", noActuals[0].forecastMW, 770);
check("row0 mwLoss (forecast basis)", noActuals[0].mwLoss, 400);
check(
  "row0 mwhThisInterval",
  noActuals[0].mwhThisInterval,
  400 * (5 / 60),
  0.0001,
); // 33.333
check("row47 cumMWh (all forecast)", noActuals[47].cumMWh, 1600, 0.01);

console.log("\nDynamic catch-up — first 6 rows overshoot, target should drop after...");
// Operator runs the units higher than forecast for the first 30 min (6 rows of 5 min).
// Each overshoot row: cap - actual = 1170 - 1100 = 70 MW loss. forecast was 400 MW loss.
// Shortfall per row vs forecast = 330 MW * (5/60) = 27.5 MWh short.
// After 6 rows: 6 * 27.5 = 165 MWh short of plan.
// Subsequent target should rise to recover. Build actuals map: lyb1=550, lyb2=550 → total 1100.
const overshootActuals: ActualsByInterval = new Map();
for (let i = 0; i < 6; i++) {
  overshootActuals.set(schedule[i].intervalEnding, { lyb1: 550, lyb2: 550 });
}
const dyn = applyActuals(schedule, overshootActuals, config);
// Cum delivered after 6 overshoot rows = 6 * 70 * (5/60) = 35 MWh.
check("row5 cumMWh after overshoot", dyn[5].cumMWh, 35, 0.01);
// Row 6 target: remaining = 1600 - 35 = 1565 MWh; remaining hours = 42 rows * 5/60 = 3.5 hrs.
// target = 1565 / 3.5 ≈ 447.14 MW (higher than original 400 — catch-up).
check("row6 dynamic target", dyn[6].targetOffloadMW, 1565 / 3.5, 0.01);
// All 48 rows still land on 1600 MWh total.
check("row47 cumMWh (overshoot then forecast catch-up)", dyn[47].cumMWh, 1600, 0.01);

console.log("\nDynamic catch-up — undershoot pulls target down...");
// First 6 rows actuals exactly match forecast (1170 - 400 = 770 MW total → lyb1=lyb2=385).
// Then rows 6-11 undershoot heavily: actual 1170 (full cap, zero reduction).
const underActuals: ActualsByInterval = new Map();
for (let i = 0; i < 6; i++) {
  underActuals.set(schedule[i].intervalEnding, { lyb1: 385, lyb2: 385 });
}
for (let i = 6; i < 12; i++) {
  underActuals.set(schedule[i].intervalEnding, { lyb1: 585, lyb2: 585 });
}
const under = applyActuals(schedule, underActuals, config);
// First 6 rows on plan: 6 * 33.333 = 200 MWh.
// Next 6 rows zero loss: still 200 MWh delivered after row 11.
check("row11 cumMWh (6 on-plan + 6 zero)", under[11].cumMWh, 200, 0.01);
// Row 12 target: remaining = 1400 MWh; remaining hours = 36 rows * 5/60 = 3 hrs → 466.67 MW.
check("row12 dynamic target (catch up after stall)", under[12].targetOffloadMW, 1400 / 3, 0.01);
check("row47 cumMWh (still lands on target)", under[47].cumMWh, 1600, 0.01);

console.log("\nTarget clamps to [0, totalCap]...");
// Tiny remaining MWh near the end → target stays >= 0. Force cum >> mwReduction by feeding
// huge actual losses early.
const overActuals: ActualsByInterval = new Map();
for (let i = 0; i < 6; i++) {
  // actual = 0 → mwLoss = 1170 → 97.5 MWh per row → 585 MWh in 6 rows.
  overActuals.set(schedule[i].intervalEnding, { lyb1: 0, lyb2: 0 });
}
const over = applyActuals(schedule, overActuals, config);
check("row5 cumMWh (massive over)", over[5].cumMWh, 6 * 1170 * (5 / 60), 0.01);
// Row 6: remaining = 1600 - 585 = 1015; remaining hrs = 42 * 5/60 = 3.5 → 290 MW (still positive).
check("row6 target after early over", over[6].targetOffloadMW, 1015 / 3.5, 0.01);
// If cum > mwReduction (negative remaining), target clamps to 0.
const ridiculous: ActualsByInterval = new Map();
for (let i = 0; i < 24; i++) {
  ridiculous.set(schedule[i].intervalEnding, { lyb1: 0, lyb2: 0 });
}
const rid = applyActuals(schedule, ridiculous, config);
// After 24 rows of zero output: cum = 24 * 1170 * 5/60 = 2340 MWh > 1600. Target should clamp to 0.
check("row24 target clamps to 0 when over-delivered", rid[24].targetOffloadMW, 0);

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
