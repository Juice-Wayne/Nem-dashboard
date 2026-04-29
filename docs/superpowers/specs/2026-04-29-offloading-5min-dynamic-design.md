# Coal Offloading — 5-min Sensitivity & Dynamic Target

**Date:** 2026-04-29
**Status:** Approved (brainstorm)
**Supersedes parts of:** `docs/superpowers/specs/2026-04-24-coal-offloading-tab-design.md`

## Goal

Tighten the offloading tool so the operator can steer the event in real time:

- Drop row resolution from 30 min to **5 min** so the table reflects AEMO's native dispatch cadence.
- Recompute `Target MW` **dynamically** from cumulative MWh delivered so far, so overshoot or undershoot redistributes across remaining intervals automatically.
- Strip out columns that aren't pulling weight (`Less gas` inputs and the duplicated per-unit / total-actual block on the right side of the table).

The summary card, config card, "Target Offload MWh", "MW Loss", "Cum MWh Loss" and bid targets all stay — they just operate on 5-min rows.

## Non-goals

- No new "current MW" anchor cell (deferred — the operator may want this later for the active row).
- No change to the AEMO archive fetch path or `lib/nemweb` plumbing — only the bucketing changes.
- No change to the summary copy text format beyond reflecting the dynamic forecast.
- No change to `progressState` thresholds (still ±10%).

## Architecture changes

### Schedule (`lib/offloading/math.ts`)

`buildSchedule` and `applyActuals` continue to be the only two functions the component calls.

- `rowCount(config)` returns `durationHrs * 12` (5-min rows). Round to integer.
- Each row steps **5 min** instead of 30. `hhEnding` field renamed to `intervalEnding` to match the new cadence (or kept as `hhEnding` purely for diff size — pick whichever has lower blast radius during implementation; document the choice in the plan).
- `targetOffloadMW` is no longer a static field on `ScheduleRow`. Instead it lives on `ComputedRow` because it depends on cumulative MWh delivered through prior rows, which only `applyActuals` knows.
- `lyb1TargetMW` / `lyb2TargetMW` likewise move to `ComputedRow` (dynamic), computed as:
  - `lyb1Target = max(0, lyb1Cap - target/2)`
  - `lyb2Target = max(0, lyb2Cap - target/2)`
- MWh per row = `MW × 5 / 60` (replacing the prior `MW / 2`).

### Dynamic target formula

For each row, compute target before computing this row's MWh:

```
remainingMWh   = mwReduction - cumMWh_delivered_through_prior_rows
remainingHours = (rowCount - rowsCompletedSoFar) × 5 / 60
target         = remainingMWh / remainingHours      // MW
```

`cumMWh_delivered_through_prior_rows` uses each prior row's `mwhThisInterval`, which is `(cap - basisMW) × 5 / 60`. `basisMW` is `totalActualMW` when present (AEMO actual), else `forecastMW` (the prior row's bid total — derived from the prior row's dynamic target).

This gives the linear-catch-up behaviour: any prior overshoot pulls the target down on subsequent rows; any undershoot pushes it up.

Edge cases:
- `remainingHours == 0` (last row): target = `2 × remainingMWh / (5/60)` would divide by zero. Use `target = remainingMWh × 12` (MWh → MW for a 5-min slot) for the last row only.
- Target clamped to `[0, totalCap]` — never asks the units to deliver more reduction than they have headroom for, never goes negative.

### API (`app/api/offloading/route.ts`)

- Stop bucketing 5-min SCADA into 30-min averages. Each AEMO 5-min interval becomes one response entry.
- Response shape becomes `{ intervals: Array<{ intervalEnding: string; lyb1Mw: number | null; lyb2Mw: number | null }> }`. Per-unit MW kept (the component sums to `Actual MW` and a future "current MW" cell may want per-unit).
- `enumerateHHs` → `enumerateIntervals(startISO, durationHrs)` returns `durationHrs × 12` ISO timestamps stepping 5 min from `startISO`.
- `bucketHHEnding` is deleted — AEMO `SETTLEMENTDATE` already aligns to 5-min interval-endings.
- Cache headers unchanged (`s-maxage=60, stale-while-revalidate=300`).

### Component (`components/offloading-tab.tsx`)

- `nextHalfHourISO` → `nextFiveMinISO` (round up to next 5-min boundary).
- Storage key `nem-offloading-config` stays. On hydrate, if a stored `startISO` doesn't align to a 5-min boundary, snap it forward.
- Time picker minute options: keep 5-min steps (already 5-min). No change needed.
- Table columns (left → right): `Interval ending`, `Target MW`, `Target Offload MWh`, `Forecast MW`, `Actual MW`, `MW Loss`, `Act Offload MWh`, `Cum MWh Loss`, `LYB1 Bid target`, `LYB2 Bid target`, `Total bid`. The five right-most columns (`LYB1 actual`, `Less gas LYB1`, `LYB2 actual`, `Less gas LYB2`, `Total actual`) and their headers/EditableCell wiring are deleted.
- The `Actual MW` cell stops using gas-subtracted total — it shows the raw AEMO total (`lyb1Mw + lyb2Mw`) when both are present, else `—` or italic forecast fallback (existing pattern).
- `OVERRIDE_FIELDS` reduces to just `lyb1Actual`/`lyb2Actual`? No — those columns are gone too. Per-row overrides are no longer needed; remove `overridesMap`, `setOverride`, `handlePaste`, and the `EditableCell` import/component. Operator simply edits the **config card** and watches the schedule respond. (If we lose paste-fill we lose paste-fill — flag in plan; can re-add as a single "manual actuals" path later if requested.)
- `RowOverrides`, `OverridesByHH`, and the override-tracking `overridden` field on `ComputedRow` are removed from `math.ts`.
- Header label `HH ending` → `Interval ending`. Subtitle stays "Market Time".
- Provenance colour-coding (`SRC.CALC` / `SRC.AEMO` / `SRC.INPUT`) — `SRC.INPUT` is no longer used in the table (only in the config card inputs). Keep it for the config card; remove it from header definitions for table columns.

### Summary text

`Coal offloading event — LYB reducing to ~${forecastMW.toFixed(0)} MW from interval ${startLabel} to ${endLabel}. Target ${mwReduction} MWh reduction.` — `forecastMW` now reads from the **first row's dynamic forecast**, which equals the initial-state forecast (cumulative-delivered = 0, so target reduces to `mwReduction / durationHrs`, same as today's static value). No copy change.

## Data flow

```
config (durationHrs, mwReduction, startISO, lyb1Cap, lyb2Cap)
  → buildSchedule        → ScheduleRow[] (just timestamps now)
  → API /api/offloading  → ActualsByInterval (Map<intervalEnding, {lyb1, lyb2}>)
  → applyActuals         → ComputedRow[] (with dynamic target, bid targets, MW loss, cum MWh)
  → table renders 11 columns
```

## Testing

- `scripts/verify-offloading-math.ts` — extend to cover:
  - 5-min row count for several `durationHrs` (1, 4, 12).
  - Dynamic target redistributes correctly: feed actuals that overshoot for first 6 rows, assert subsequent target drops and cumMWh lands on `mwReduction` at the end.
  - Last-row edge case: target divides correctly when `remainingHours == 5/60`.
  - Target clamps to `[0, totalCap]`.
- Manual UI check: load a past day, verify rows are 5-min, AEMO actuals populate, `Actual MW` matches sum of unit SCADA, `Target MW` recomputes when an actual lands above/below forecast.

## Open questions for plan-time

- Rename `hhEnding` → `intervalEnding` everywhere, or keep the old field name to minimise churn? Plan should pick one and apply consistently.
- Do we need a one-time migration of the localStorage `nem-offloading-config` (no schema change actually — `startISO` is still ISO; only the rounding helper differs)?

## Out of scope (follow-ups)

- "Current MW" cell with manual-override capability for the active row.
- Surfacing the dynamic target's "remaining MWh / remaining hours" in a status strip (was previously the progress bar — already removed).
- Per-row manual actual override (paste-fill). If operator workflow needs it, re-add via a single editable `Actual MW` column.
