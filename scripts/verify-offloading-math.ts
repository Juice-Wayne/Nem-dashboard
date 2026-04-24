/**
 * Verify math.ts against the known-good Q326 workbook values.
 * Run: npx tsx scripts/verify-offloading-math.ts
 */
import { buildSchedule, applyActuals, offloadRate, totalCap, type OffloadConfig } from "../lib/offloading/math";

// Q326 workbook inputs (from context/LYB Coal Offloading - Q326.xlsx sheet "LYB targets for offload")
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
  else console.log(`  ✓ ${label} = ${got}`);
}

console.log("Verifying OffloadConfig helpers...");
check("totalCap", totalCap(config), 1170);
check("offloadRate", offloadRate(config), 400);  // 1600 total / 4 hrs

console.log("\nVerifying buildSchedule...");
const schedule = buildSchedule(config);
check("rowCount", schedule.length, 8);          // 4hr * 2
check("row0 targetOffloadMW", schedule[0].targetOffloadMW, 400);
check("row0 lyb1TargetMW", schedule[0].lyb1TargetMW, 385);  // 585 - 400/2
check("row0 lyb2TargetMW", schedule[0].lyb2TargetMW, 385);
check("row0 forecastMW", schedule[0].forecastMW, 770);      // total - offload

console.log("\nVerifying applyActuals (no overrides, no AEMO — forecast fallback)...");
const computed = applyActuals(schedule, new Map(), new Map(), config);
check("row0 mwLoss (forecast basis)", computed[0].mwLoss, 400);    // 1170 - 770
check("row0 mwhThisHH", computed[0].mwhThisHH, 200);
check("row7 cumMWh (all forecast)", computed[7].cumMWh, 1600);     // 200 * 8

console.log("\nVerifying applyActuals with one AEMO value...");
const aemo = new Map([[schedule[0].hhEnding, 1150]]);  // workbook row 11: F11=1150
const withAemo = applyActuals(schedule, aemo, new Map(), config);
check("row0 actualMW from AEMO", withAemo[0].actualMW ?? -1, 1150);
check("row0 mwLoss with AEMO", withAemo[0].mwLoss, 20);            // workbook G11=20
check("row0 mwhThisHH", withAemo[0].mwhThisHH, 10);                // workbook H11=10

console.log("\nVerifying user override wins over AEMO...");
const overrides = new Map([[schedule[0].hhEnding, { actualMW: 900 }]]);
const withOverride = applyActuals(schedule, aemo, overrides, config);
check("row0 actualMW from override", withOverride[0].actualMW ?? -1, 900);
check("row0 overridden.actualMW flag", withOverride[0].overridden.actualMW ? 1 : 0, 1);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n✓ All checks passed.");
