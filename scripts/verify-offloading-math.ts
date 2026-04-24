/**
 * Verify math.ts against the known-good Q326 workbook values.
 * Run: npx tsx scripts/verify-offloading-math.ts
 */
import { buildSchedule, applyActuals, offloadRate, totalCap, type OffloadConfig } from "../lib/offloading/math";

// Q326 workbook inputs (context/LYB Coal Offloading - Q326.xlsx, sheet "LYB targets for offload")
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

console.log("Verifying OffloadConfig helpers...");
check("totalCap", totalCap(config), 1170);
check("offloadRate", offloadRate(config), 400);  // 1600 total / 4 hrs

console.log("\nVerifying buildSchedule...");
const schedule = buildSchedule(config);
check("rowCount", schedule.length, 8);
check("row0 targetOffloadMW", schedule[0].targetOffloadMW, 400);
check("row0 targetCumMWh", schedule[0].targetCumMWh, -200);  // -(1 * 400/2)
check("row1 targetCumMWh", schedule[1].targetCumMWh, -400);
check("row7 targetCumMWh", schedule[7].targetCumMWh, -1600);
check("row0 lyb1TargetMW", schedule[0].lyb1TargetMW, 385);   // 585 - 400/2
check("row0 lyb2TargetMW", schedule[0].lyb2TargetMW, 385);
check("row0 forecastMW", schedule[0].forecastMW, 770);

console.log("\nVerifying applyActuals (no overrides, no AEMO — forecast fallback)...");
const computed = applyActuals(schedule, new Map(), new Map(), config);
check("row0 mwLoss (forecast basis)", computed[0].mwLoss, 400);
check("row0 mwhThisHH", computed[0].mwhThisHH, 200);
check("row7 cumMWh (all forecast)", computed[7].cumMWh, 1600);

console.log("\nVerifying applyActuals with AEMO per-unit values (workbook row 11)...");
const aemo = new Map([[schedule[0].hhEnding, { lyb1: 575.6, lyb2: 579.8 }]]);
const withAemo = applyActuals(schedule, aemo, new Map(), config);
check("row0 lyb1Actual", withAemo[0].lyb1Actual ?? -1, 575.6);
check("row0 lyb2Actual", withAemo[0].lyb2Actual ?? -1, 579.8);
check("row0 totalActualMW (no gas)", withAemo[0].totalActualMW ?? -1, 1155.4);
check("row0 mwLoss", withAemo[0].mwLoss, 14.6);              // 1170 - 1155.4
check("row0 mwhThisHH", withAemo[0].mwhThisHH, 7.3);

console.log("\nVerifying gas override subtracts from total...");
const overrides = new Map([[schedule[0].hhEnding, { lyb1Gas: 10, lyb2Gas: 5 }]]);
const withGas = applyActuals(schedule, aemo, overrides, config);
check("row0 lyb1Gas", withGas[0].lyb1Gas, 10);
check("row0 lyb2Gas", withGas[0].lyb2Gas, 5);
check("row0 totalActualMW (with gas)", withGas[0].totalActualMW ?? -1, 1140.4); // 575.6 - 10 + 579.8 - 5
check("row0 overridden.lyb1Gas", withGas[0].overridden.lyb1Gas ? 1 : 0, 1);

console.log("\nVerifying user actual override wins over AEMO...");
const ovActual = new Map([[schedule[0].hhEnding, { lyb1Actual: 500 }]]);
const withOv = applyActuals(schedule, aemo, ovActual, config);
check("row0 lyb1Actual (override)", withOv[0].lyb1Actual ?? -1, 500);
check("row0 lyb2Actual (still AEMO)", withOv[0].lyb2Actual ?? -1, 579.8);
check("row0 overridden.lyb1Actual", withOv[0].overridden.lyb1Actual ? 1 : 0, 1);
check("row0 overridden.lyb2Actual", withOv[0].overridden.lyb2Actual ? 1 : 0, 0);

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
