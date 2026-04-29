/**
 * Verify lib/offloading/math.ts behaviour for PD-target + ramp-aware bidding.
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
  type PDByInterval,
} from "../lib/offloading/math";

const config: OffloadConfig = {
  startISO: "2025-07-01T13:00:00.000Z",
  durationHrs: 4,
  mwReduction: 1600, // MWh
  lyb1Cap: 585,
  lyb2Cap: 585,
  lyb1RampRate: 10, // MW/min
  lyb2RampRate: 10,
};

const failures: string[] = [];
function check(label: string, got: number | null, want: number | null, tol = 0.01) {
  const okNull = got == null && want == null;
  const okNum = got != null && want != null && Math.abs(got - want) <= tol;
  if (okNull || okNum) console.log(`  OK ${label} = ${got}`);
  else failures.push(`${label}: got ${got}, want ${want}`);
}

function pdMap(pdLyb1: number, pdLyb2: number, intervals: string[]): PDByInterval {
  const m: PDByInterval = new Map();
  for (const iv of intervals) m.set(iv, { lyb1: pdLyb1, lyb2: pdLyb2 });
  return m;
}

console.log("Constants & helpers...");
check("INTERVAL_MIN", INTERVAL_MIN, 5);
check("totalCap", totalCap(config), 1170);
check("reductionMW (uniform)", reductionMW(config), 400);
check("rowCount(4hr)", rowCount(config), 48);

console.log("\nbuildSchedule timeline...");
const schedule = buildSchedule(config);
check("schedule length", schedule.length, 48);
check(
  "row1 step is 5 min after row0",
  new Date(schedule[1].intervalEnding).getTime() - new Date(schedule[0].intervalEnding).getTime(),
  5 * 60 * 1000,
);
check("row0 targetCumMWh", schedule[0].targetCumMWh, -33.333);
check("row47 targetCumMWh", schedule[47].targetCumMWh, -1600, 0.01);

console.log("\ncomputeRows — PD const at 500, units ramp down at 50 MW/interval...");
// avgTarget = 500 - 200 = 300 per unit. rawBid = 2*300 - prevEnd.
// row 0: prev=500 → raw=100 → ramp clamp 450. row 1: prev=450 → raw=150 → ramp clamp 400. ... row 3: prev=350 → raw=250 → ramp clamp 300. row 4: prev=300 → raw=300 → bid 300 (steady).
const intervals = schedule.map((r) => r.intervalEnding);
const pd500 = pdMap(500, 500, intervals);
const rows500 = computeRows(config, pd500);

check("row0 pdLyb1", rows500[0].pdLyb1, 500);
check("row0 pdTotal", rows500[0].pdTotal, 1000);
check("row0 reductionMW", rows500[0].reductionMW, 400);
check("row0 avgTargetTotal", rows500[0].avgTargetTotal, 600);
check("row0 lyb1BidMW (clamped)", rows500[0].lyb1BidMW, 450);
check("row0 lyb2BidMW (clamped)", rows500[0].lyb2BidMW, 450);
check("row0 lyb1AvgAchievedMW", rows500[0].lyb1AvgAchievedMW, 475);
// Row 0: pd=1000, avg total=475+475=950 → reduction = 50 MW × 5/60
check("row0 reductionMWhThisInterval", rows500[0].reductionMWhThisInterval, (1000 - 950) * (5 / 60), 0.001);

check("row1 lyb1BidMW", rows500[1].lyb1BidMW, 400);
check("row2 lyb1BidMW", rows500[2].lyb1BidMW, 350);
check("row3 lyb1BidMW", rows500[3].lyb1BidMW, 300);
check("row4 lyb1BidMW (steady)", rows500[4].lyb1BidMW, 300);
check("row47 lyb1BidMW (steady)", rows500[47].lyb1BidMW, 300);

console.log("\ncomputeRows — physical clamp at 0...");
// PD=100 → avgTarget=-100 → rawBid=-200-prev. row 0: prev=100, raw=-300, ramp 100±50 → 50.
// row 1: prev=50, raw=-250, ramp 50±50 → 0. row 2: prev=0, raw=-200, ramp 0±50 → -50, physical clamp → 0.
const pd100 = pdMap(100, 100, intervals);
const rowsLow = computeRows(config, pd100);
check("row0 lyb1BidMW (ramp limits drop)", rowsLow[0].lyb1BidMW, 50);
check("row1 lyb1BidMW (ramp again)", rowsLow[1].lyb1BidMW, 0);
check("row2 lyb1BidMW (physical clamp at 0)", rowsLow[2].lyb1BidMW, 0);

console.log("\ncomputeRows — PD missing → bid is null until PD becomes available...");
const pdSparse: PDByInterval = new Map();
for (let i = 0; i < 48; i++) {
  pdSparse.set(intervals[i], i < 6 ? { lyb1: null, lyb2: null } : { lyb1: 500, lyb2: 500 });
}
const rowsSparse = computeRows(config, pdSparse);
check("row0 pd null → bid null", rowsSparse[0].lyb1BidMW, null);
check("row0 cumReductionMWh = 0", rowsSparse[0].cumReductionMWh, 0);
check("row5 cumReductionMWh still 0", rowsSparse[5].cumReductionMWh, 0);
check("row6 has bid (PD became available)", rowsSparse[6].lyb1BidMW, 450);
check("row6 cumReductionMWh advances", rowsSparse[6].reductionMWhThisInterval > 0 ? 1 : 0, 1);

console.log(`\nrow47 cumReductionMWh (PD=500) = ${rows500[47].cumReductionMWh.toFixed(1)} MWh (uniform target was 1600)`);

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
