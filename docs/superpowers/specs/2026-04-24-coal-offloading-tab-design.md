# Coal Offloading Tab — Design

Replaces the LYB Coal Offloading Excel spreadsheet with an in-dashboard calculator that auto-fills Actual MW from AEMO SCADA while keeping every cell editable/pasteable for overrides.

## Background

Coal offloading is a shared energy curtailment event at Loy Yang B (LYB1 + LYB2). When the mine issues a Coal Supply Shortfall Notification, the control room must reduce LYB generation by a target **MWh over a set duration** (typically 1600 MWh over 4 hours). Today the calculations live in an Excel workbook (`LYB Coal Offloading - Q326.xlsx`) where the user pastes forecast/actual values manually. This feature brings the math into the dashboard and auto-fills actuals from AEMO.

## Scope (v1)

- One live event at a time. No history, no persistence beyond the browser.
- Manual override on every cell (spreadsheet-style paste supported).
- No chart, no notifications, no AEMO integration for SCADA call-in (user calls AEMO separately).

## Placement

- New tab `"Coal Offloading"` under the **Tools** section of the sidebar.
- Not password-gated (site-wide password already gates everything).
- TabId: `offloading`.

## Inputs panel

Persisted to `localStorage` under key `nem-offloading-config`.

| Field | Default | Notes |
|---|---|---|
| Event start | next half-hour boundary | Datetime picker, snaps to `:00` / `:30` |
| Duration (hrs) | 4 | Integer, valid range 4–12 |
| MWh reduction | 1600 | Target from notification |
| LYB1 capacity (MW) | 585 | Editable — set each quarter per offloading procedure |
| LYB2 capacity (MW) | 585 | Editable |

Derived read-out: **Offload rate = MWh_reduction / duration** (e.g. `1600 / 4 = 400` MW per HH).

## Live table

One row per half-hour from `start` to `start + duration`.

| Column | Source | Editable |
|---|---|---|
| HH ending | Derived | No |
| Target offload MW | `offload_rate` (constant) | No |
| LYB1 target MW | `LYB1_cap − (offload_rate / 2)` — default 50/50 split | **Yes** (user can shift the split) |
| LYB2 target MW | `LYB2_cap − (offload_rate / 2)` — default 50/50 split | **Yes** |
| Forecast MW | `LYB1_target + LYB2_target` (follows the split above) | No |
| Actual MW | AEMO SCADA (LYB1 + LYB2 half-hour avg) | **Yes** (override) |
| MW Loss | `total_cap − (Actual MW ?? Forecast MW)` | Derived |
| MWh this HH | `MW_Loss / 2` | Derived |
| Cum MWh | Running sum of `MWh this HH` | Derived |

*Rationale for editable LYB1/LYB2 targets:* the offloading procedure explicitly allows one unit to absorb more of the reduction than the other ("could take the entire offloading amount on one Unit") — so the default 50/50 split is just a starting point the operator can shift.

*Rationale for MW Loss fallback:* before AEMO data lands for an upcoming HH, `actualMW` is null; we use the forecast so Cum MWh projects forward. Once actual arrives, it replaces forecast for that row. This matches the Excel behaviour (rows use actual when present, forecast otherwise).

**Override semantics:**
- Any user-edited cell retains its override value and no longer follows AEMO updates. Marked with a thin coloured left border and a revert (↺) icon on hover.
- Clicking revert restores AEMO-sourced value for that cell.
- Paste (Ctrl+V) over the top-left of a range fills down and right, Excel-style. Values parse as tab/newline-separated.

**Progress indicator (below the table):**
Cumulative MWh vs `MWh_reduction` target as a progress bar with text `"1210 / 1600 MWh (76%)"`.
- Green when within ±10% of the linear target curve for the current HH
- Amber when behind (cum MWh < 90% of target-by-now)
- Red when cum MWh > 110% of target

## Actions bar

- **Copy summary** — copies AEMO call text to clipboard. Template:
  ```
  Coal offloading event — LYB reducing to ~{forecast_mw} MW from HH {start_hhmm} to {end_hhmm}.
  Target {mwh_reduction} MWh reduction.
  ```

## Data source

- **DUIDs:** `LOYYB1`, `LOYYB2` (standard AEMO registration). Sum the two for Actual MW.
- **Current day:** `DISPATCHSCADA` 5-min current feed (same source used elsewhere in dashboard). Each HH aggregates six 5-min intervals as the arithmetic mean of `SCADAVALUE`.
- **Past days:** `DISPATCHSCADA` daily archive (same path as the Revenue tab fetcher in `lib/nemweb`).
- **Polling:** SWR with 30 s refresh, only fetches the event window.

## Architecture

### New files
- `app/api/offloading/route.ts` — `GET ?start=YYYY-MM-DDTHH:MM&end=...` → `{ intervals: [{hh_ending, lyb1_mw, lyb2_mw, actual_mw}] }`. Reuses `lib/nemweb/fetcher.ts` for archive + current feed.
- `components/offloading-tab.tsx` — UI for inputs panel + editable table + action bar.
- `lib/offloading/math.ts` — pure functions for the calculation model (target-per-HH, cum MWh, progress state). Kept separate so it's trivially unit-testable.

### Edits
- `components/side-nav.tsx` — add nav item `{ id: "offloading", label: "Coal Offloading", icon: Flame }` under Tools (after BR Start, before the Revenue entries). Add `"offloading"` to the `NavTabId` union.
- `app/page.tsx` — add `"offloading"` to `TabId`, new `<TabsContent value="offloading"><OffloadingTab /></TabsContent>`.

### Data flow
```
Inputs (localStorage) ──┐
                        ├──► math.ts  ──► render table (derived)
AEMO SCADA (API) ───────┤
Overrides (component state) ┘
```
The component holds inputs + a `Record<rowKey, Partial<OverrideCells>>` of user edits. On render, for each HH row, merge: `(AEMO value) → (override if present)`; then run derived formulas.

## Calculation model (pure TS, matches Excel)

```ts
interface Config {
  startISO: string;
  durationHrs: number;
  mwhReduction: number;
  lyb1Cap: number;
  lyb2Cap: number;
}

interface Row {
  hhEnding: string;           // ISO
  targetOffloadMW: number;    // mwhReduction / durationHrs
  lyb1TargetMW: number;       // lyb1Cap - (targetOffload / 2)
  lyb2TargetMW: number;       // lyb2Cap - (targetOffload / 2)
  forecastMW: number;         // (lyb1Cap + lyb2Cap) - targetOffload
  actualMW: number | null;    // from AEMO (or override)
  mwLoss: number | null;      // totalCap - actualMW
  mwhThisHH: number | null;   // mwLoss / 2
  cumMWh: number | null;      // running sum
}
```

Pure functions:
- `buildSchedule(config): Row[]` — produces read-only derived rows without actuals.
- `applyActuals(rows, aemoByHH, overrides): Row[]` — fills Actual MW column and computes MW Loss / MWh / Cum MWh with override precedence.

## Testing

Unit tests for `lib/offloading/math.ts`:
- `buildSchedule` with duration 4 hrs produces 8 rows half-hour-aligned
- Target per HH = MWh / duration (check 1600/4 = 400)
- LYB1 + LYB2 targets sum to forecast MW = total_cap − offload
- `applyActuals` cum MWh accumulates monotonically
- Override wins over AEMO value
- Revert (override removed) restores AEMO value

Manual end-to-end:
- With a past offloading event's timestamp, verify the table matches the Excel workbook's computed values within rounding.

## Out of scope / future

- Event history / multi-event tracking.
- Chart of cumulative target vs actual (user confirmed not wanted).
- NEO/NemSight integration.
- Automatic notification parsing.
- Writing rebids to AEMO.
