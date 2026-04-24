/**
 * Trace the updated Q326 workbook scenario through the math module and print a
 * row-by-row table matching the Excel workbook's layout. Handy for verifying
 * the dashboard produces identical numbers.
 *
 * Run: npx tsx scripts/trace-q326.ts
 */
import { buildSchedule, applyActuals, offloadRate, totalCap, type OffloadConfig } from "../lib/offloading/math";

// Inputs from the updated "LYB Coal Offloading - Q326.xlsx" (sheet "LYB targets for offload"):
//   F2 Duration = 4 hrs
//   F3 Start = 2025-07-01 00:00
//   F5 MWh reduction = 1000
//   C4 LYB1 cap = 511, C5 LYB2 cap = 515
const config: OffloadConfig = {
  startISO: "2025-07-01T00:00:00.000Z",
  durationHrs: 4,
  mwReduction: 1000,
  lyb1Cap: 511,
  lyb2Cap: 515,
};

// Workbook pasted actuals (same for every row in the sheet):
//   O = LYB1 actual 464, P = gas 75, Q = LYB2 actual 465, R = gas 75
const LYB1_ACTUAL = 464;
const LYB2_ACTUAL = 465;
const GAS_EACH = 75;

const schedule = buildSchedule(config);
// Only the first HH has completed actuals (workbook scenario — one past HH, seven projected).
const actuals = new Map([[schedule[0].hhEnding, { lyb1: LYB1_ACTUAL, lyb2: LYB2_ACTUAL }]]);
const overrides = new Map([[schedule[0].hhEnding, { lyb1Gas: GAS_EACH, lyb2Gas: GAS_EACH }]]);

const rows = applyActuals(schedule, actuals, overrides, config);

console.log(`Config: duration=${config.durationHrs}h, MWh reduction=${config.mwReduction}, LYB caps=${config.lyb1Cap}+${config.lyb2Cap}=${totalCap(config)}`);
console.log(`Derived: offload rate=${offloadRate(config)} MW/hh\n`);

const pad = (s: string | number, w: number) => String(s).padStart(w);

console.log(
  [
    pad("HH end", 6), pad("Tgt MW", 7), pad("Tgt MWh", 8),
    pad("Fcast", 6), pad("Actual", 7), pad("Loss", 6),
    pad("Act MWh", 8), pad("Cum MWh", 8),
    pad("LYB1 Tgt", 9), pad("LYB2 Tgt", 9), pad("Bid Tot", 8),
    pad("LYB1", 5), pad("GasA", 5), pad("LYB2", 5), pad("GasB", 5), pad("Tot", 6),
  ].join("  "),
);
console.log("-".repeat(140));

for (const r of rows) {
  const hh = r.hhEnding.slice(11, 16);
  console.log(
    [
      pad(hh, 6),
      pad(r.targetOffloadMW, 7),
      pad(r.targetCumMWh, 8),
      pad(r.forecastMW, 6),
      pad(r.totalActualMW ?? "—", 7),
      pad(r.mwLoss.toFixed(1), 6),
      pad(r.mwhThisHH.toFixed(1), 8),
      pad(r.cumMWh.toFixed(1), 8),
      pad(r.lyb1TargetMW, 9),
      pad(r.lyb2TargetMW, 9),
      pad((r.lyb1TargetMW + r.lyb2TargetMW).toFixed(0), 8),
      pad(r.lyb1Actual ?? "—", 5),
      pad(r.lyb1Gas, 5),
      pad(r.lyb2Actual ?? "—", 5),
      pad(r.lyb2Gas, 5),
      pad(r.totalActualMW ?? "—", 6),
    ].join("  "),
  );
}

// Expected workbook values (row 11 = first HH):
//   C11 targetOffloadMW=250, D11 targetCumMWh=-125, E11 forecast=776, F11 actualTotal=779,
//   G11 MW Loss=247, H11 MWhThisHH=123.5, I11 cumMWh=123.5,
//   K11 lyb1Tgt=386, L11 lyb2Tgt=390, M11 bid total=776,
//   O11/Q11 lyb actuals=464/465, P11/R11 gas=75, S11 total=779
console.log("\nExpected workbook row 11 (sanity check):");
console.log("  Target MW/hh=250, Target Cum MWh=-125, Forecast=776, Actual Tot=779");
console.log("  MW Loss=247, MWh/HH=123.5, Cum MWh=123.5");
console.log("  LYB1 Tgt=386, LYB2 Tgt=390, Bid Total=776, S11=779");
