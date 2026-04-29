# Coal Offloading — PD-Target + Ramp-Aware Bidding

**Date:** 2026-04-29
**Status:** Approved (brainstorm)
**Supersedes parts of:** `docs/superpowers/specs/2026-04-29-offloading-5min-dynamic-design.md`

## Goal

Replace the dynamic-catch-up Target MW logic with an explicit ramp-aware bid-trajectory model that uses AEMO **predispatch / dispatch unit targets (PD targets)** as the "what we'd be running absent the offload" baseline.

The operator wants to: enter event window + total MWh reduction → see the ramp-aware bid target each unit should be set to, accounting for where the unit was actually heading (PD), the per-unit ramp rate, and the desire to deliver a uniform reduction across the window.

Trim columns to the operationally useful set, drop the colour-key legend, and let the operator copy each unit's bid column into a bid sheet with one click.

## Non-goals

- Dynamic catch-up math: removed for v1. The operator sees `Cum delivered MWh` against the requested reduction and judges manually.
- Per-row manual overrides for any value: removed (operator drives event by editing config).
- Neopoint as a PD-target source: deferred — provider abstraction allows swap-in later, but the only confirmed working source today is AEMO.

## Architecture

### Data sources

PD targets read from AEMO end-to-end through one provider abstraction:

```
lib/offloading/pd-source.ts → getPDTargets(start: ISO, durationHrs: number)
                                                → Map<intervalEnding, { lyb1: number, lyb2: number }>
```

Internally fetches:
- **Past intervals** → `Next_Day_Dispatch` archive zips. Each contains `DISPATCHLOAD` table with `TOTALCLEARED` per DUID per 5-min ending. Same daily-zip cadence as our existing `DISPATCHSCADA` fetch path.
- **Forward intervals (within ~1 hr)** → `P5_Reports` (P5MIN). Each P5MIN run forecasts 12 intervals ahead. Use the *latest published* run for each interval (so a planner sees what AEMO is currently saying).
- **Forward intervals (1 hr to 36 hr)** → `Predispatch_Reports`. Native 30-min granularity. Linear-interpolate to 5-min within each 30-min PD interval.

The route at `app/api/offloading/route.ts` continues to return SCADA actuals (already wired) and additionally returns PD targets per interval. New response shape:

```ts
{
  intervals: Array<{
    intervalEnding: string;
    scadaLyb1: number | null;     // SCADA actual (existing, renamed from lyb1Mw)
    scadaLyb2: number | null;     // existing, renamed from lyb2Mw
    pdLyb1: number | null;        // NEW — PD target per unit
    pdLyb2: number | null;
  }>
}
```

(SCADA actuals stay in the response for potential future use even though we're removing the Actual MW column. The provider can return them at zero extra cost.)

### Math (`lib/offloading/math.ts`)

Replace the current `applyActuals` flow. New types:

```ts
export interface OffloadConfig {
  startISO: string;
  durationHrs: number;
  mwReduction: number;          // total MWh reduction across the event
  lyb1Cap: number;
  lyb2Cap: number;
  lyb1RampRate: number;         // MW/min, default 10
  lyb2RampRate: number;         // MW/min, default 10
}

export interface PDByInterval {
  // Map intervalEnding → per-unit PD-target MW
}

export interface ComputedRow {
  intervalEnding: string;
  pdLyb1: number | null;        // AEMO PD-target per unit (null if not yet available)
  pdLyb2: number | null;
  pdTotal: number | null;       // pdLyb1 + pdLyb2 (null if either missing)
  reductionMW: number;          // uniform: mwReduction / durationHrs
  avgTargetTotal: number | null;// pdTotal - reductionMW (null if pdTotal missing)
  avgTargetLyb1: number | null; // pdLyb1 - reductionMW/2
  avgTargetLyb2: number | null; // pdLyb2 - reductionMW/2
  lyb1BidMW: number | null;     // ramp-aware end-of-interval MW (null if PD missing)
  lyb2BidMW: number | null;
  lyb1AvgAchievedMW: number | null; // (prevEnd + bid) / 2 (linear ramp assumption)
  lyb2AvgAchievedMW: number | null;
  reductionMWhThisInterval: number; // delivered: (cap - avgAchieved) summed over both units × intervalHours
  cumReductionMWh: number;
}
```

Algorithm `computeRows(config, pdByInterval)`:

```
for each row i (5-min interval):
  pd1 = pdByInterval[row.intervalEnding].lyb1 ?? null
  pd2 = pdByInterval[row.intervalEnding].lyb2 ?? null
  reductionMW = config.mwReduction / config.durationHrs   // constant, e.g. 1600/4 = 400
  avgTargetLyb1 = pd1 != null ? pd1 - reductionMW/2 : null
  avgTargetLyb2 = pd2 != null ? pd2 - reductionMW/2 : null

  // bid math, per unit:
  // bid = end-of-interval MW such that linear-ramp avg(prevEnd, bid) = avgTarget
  //     = 2 × avgTarget − prevEnd
  // clamped by ramp limit and unit physical bounds
  for each unit u:
    if i == 0:
      prevEndU = pdU                                       // assume unit was at PD-target entering event
    rampMW_u = config.{u}RampRate × INTERVAL_MIN          // e.g. 10 × 5 = 50 MW per interval
    rawBid = avgTargetU != null ? 2 × avgTargetU − prevEndU : null
    bidU = rawBid != null
              ? clamp(rawBid, prevEndU − rampMW_u, prevEndU + rampMW_u)   // ramp clamp
              : null
    bidU = bidU != null ? clamp(bidU, 0, unitCap_u) : null                // physical clamp
    avgAchievedU = bidU != null ? (prevEndU + bidU) / 2 : null
    prevEndU = bidU ?? prevEndU                                            // carry forward

  reductionMWhThisInterval = (totalCap - (avgAchievedLyb1 + avgAchievedLyb2)) × (INTERVAL_MIN/60)
                           = 0 if either avgAchieved missing
  cumReductionMWh += reductionMWhThisInterval
```

**Clamps explained:**
- Ramp clamp: physical reality — the unit can move at most `rampRate × intervalMin` MW between the start and end of any 5-min interval.
- `[0, unitCap]`: a unit can't run negative or above its registered capacity.

**Asymmetry note:** the rawBid calc gives the end-MW that produces the requested average *given linear ramp*. If the unit can ramp fast enough to hit avgTarget mid-interval and sit there, the achieved avg over the full interval is closer to avgTarget than `(prev+end)/2` predicts. For v1 we accept the linear-ramp simplification — it's accurate when units ramp continuously (the common case in offloading) and conservative when they don't.

### Component (`components/offloading-tab.tsx`)

- **Config card additions:** `Ramp ROC LYB1` and `Ramp ROC LYB2` (MW/min, default 10), yellow-tinted inputs alongside the existing capacity fields.
- **Removed:** `DebugLegend` block (the colour-key tooltip) — gone entirely.
- **Removed columns:** `Actual MW`, `MW Loss`, `Forecast MW`, `Target Offload MWh` (cumulative target — replaced by reading config + Cum delivered), `Total bid` (just LYB1 + LYB2 — unnecessary).
- **New columns** (7 total):

| # | Header | Source | Colour | Notes |
|---|--------|--------|--------|-------|
| 1 | Interval ending | calc | orange | existing |
| 2 | PD Gen MW | AEMO | **blue** | sum of pdLyb1 + pdLyb2 |
| 3 | Reduction MW | calc | orange | constant per row |
| 4 | Avg target MW | calc | orange | PD − reduction |
| 5 | LYB1 Bid | calc | **purple** | ramp-aware end-of-interval MW; copy-column button in header |
| 6 | LYB2 Bid | calc | **purple** | same |
| 7 | Cum delivered MWh | calc | orange | running |

- **Copy button:** small clipboard icon in `LYB1 Bid` and `LYB2 Bid` column headers. Click → copies all 48 values as newline-separated numbers (e.g. `385.0\n383.7\n...`). Toast (existing pattern from `SummaryCard`) confirms.

### Colour palette additions

- `SRC.BID = "bg-purple-500/15"` (cell)
- `HEADER_SRC.BID = "bg-purple-500/30"` (header)

### Storage / migration

LocalStorage `nem-offloading-config` adds two keys (`lyb1RampRate`, `lyb2RampRate`). Backward-compat in `loadConfig`: if missing, default to 10. No migration needed for users on the prior schema.

## Data flow

```
config (durationHrs, mwReduction, startISO, lyb1Cap, lyb2Cap, lyb1RampRate, lyb2RampRate)
  → buildSchedule         → ScheduleRow[] (timestamps only — unchanged)
  → API /api/offloading   → { intervals[]: scadaLyb1/2, pdLyb1/2 } (NEW: pd fields)
  → component pulls pdByInterval
  → computeRows(config, pdByInterval) → ComputedRow[]
  → table renders 7 columns
```

## Testing

- `scripts/verify-offloading-math.ts` — replace tests:
  - Ramp-down trajectory: PD const at 500 across event, reduction 400 MWh/4hr → ramp-down at 50 MW/interval until reaching offload setpoint, then hold. Verify intermediate row bids match expected ramp.
  - Ramp clamp triggers: when `avgTarget` requires more than `rampMW` swing, bid clamps to `prevEnd − rampMW`.
  - Physical clamp: when computed bid would be negative, clamps to 0.
  - PD missing: row's bid/avg fields are null, `cumReductionMWh` doesn't advance.
  - Cum delivered matches the steady-state result for a long-enough event (after ramp-in, the unit holds at offload setpoint and delivers exactly `reductionMW × durationHrs = mwReduction` MWh — modulo the ramp shortfall).
- Manual UI: load a past day, confirm PD column populates from `Next_Day_Dispatch`, bid columns show ramp-down trajectory, copy-button paste produces newline-separated numbers.

## Out of scope (follow-ups)

- Dynamic catch-up: re-add later if operator finds the steady-state shortfall awkward to manage manually.
- Per-row manual override of PD target (e.g. operator knows AEMO's PD is wrong before it updates).
- Neopoint provider implementation: keep behind the `getPDTargets` interface so it slots in if/when their unit feed is identified.
- Future-interval interpolation refinements (e.g. cubic instead of linear between PD 30-min steps).
