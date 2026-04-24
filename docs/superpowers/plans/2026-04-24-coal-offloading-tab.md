# Coal Offloading Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "Coal Offloading" dashboard tab that replaces the LYB Coal Offloading Excel workbook — inputs drive an editable half-hourly table that auto-fills Actual MW from AEMO SCADA and shows cumulative MWh progress vs target.

**Architecture:** Pure calculation module (`lib/offloading/math.ts`) owns the formulas; API route (`app/api/offloading/route.ts`) pulls `DISPATCHSCADA` for the LOYYB1/LOYYB2 DUIDs and aggregates to half-hour buckets; React component (`components/offloading-tab.tsx`) renders inputs + editable table with spreadsheet-style paste overrides. State persists in `localStorage`.

**Tech Stack:** Next.js 15 App Router, React, TypeScript, SWR for data fetching, shadcn/ui table primitives, lucide-react icons. No test framework is present — we verify math correctness with a runnable `tsx` verification script that compares output against the Q326 workbook fixture.

---

## File Structure

**New files**
- `lib/offloading/math.ts` — pure calculation functions (schedule builder + actuals application)
- `app/api/offloading/route.ts` — GET endpoint returning `{intervals: [{hhEnding, lyb1Mw, lyb2Mw}]}` for a given window
- `components/offloading-tab.tsx` — React component for the tab
- `scripts/verify-offloading-math.ts` — sanity check that replicates Excel Q326 values

**Modified files**
- `components/side-nav.tsx` — add `"offloading"` to NavTabId union + nav entry under Tools
- `app/page.tsx` — add `"offloading"` to TabId + `<TabsContent>` block + import

**Boundaries**
- `math.ts` knows nothing about React, fetch, or localStorage — only types + pure functions. This makes it trivially inspectable via the verify script.
- `route.ts` knows nothing about the calculation model — it only returns raw AEMO values. Calculations happen on the client from inputs + AEMO data + user overrides.
- `offloading-tab.tsx` orchestrates: reads inputs from localStorage, calls the API, merges overrides, renders via `math.ts`.

---

## Task 1: Pure calculation module

**Files:**
- Create: `lib/offloading/math.ts`
- Create: `scripts/verify-offloading-math.ts`

- [ ] **Step 1: Create `lib/offloading/math.ts` with types and schedule builder**

```typescript
// lib/offloading/math.ts

export interface OffloadConfig {
  /** ISO timestamp for the first HH ending (e.g. "2025-07-01T13:00:00"). */
  startISO: string;
  /** Event length in hours (integer, 4–12). */
  durationHrs: number;
  /** Target cumulative MWh reduction for the whole event. */
  mwhReduction: number;
  /** Unit 1 registered capacity in MW. */
  lyb1Cap: number;
  /** Unit 2 registered capacity in MW. */
  lyb2Cap: number;
}

/** One half-hour row in the offloading table. */
export interface ScheduleRow {
  hhEnding: string;           // ISO timestamp
  targetOffloadMW: number;    // constant MWh_reduction / durationHrs
  lyb1TargetMW: number;       // lyb1Cap - targetOffload/2 (editable by user)
  lyb2TargetMW: number;       // lyb2Cap - targetOffload/2 (editable by user)
  forecastMW: number;         // lyb1TargetMW + lyb2TargetMW
}

/** Overrides for a single row. Undefined fields fall back to defaults / AEMO. */
export interface RowOverrides {
  lyb1TargetMW?: number;
  lyb2TargetMW?: number;
  actualMW?: number;
}

/** Row after actuals and overrides are applied. */
export interface ComputedRow extends ScheduleRow {
  actualMW: number | null;     // AEMO value (or override); null if neither available
  mwLoss: number;              // totalCap - (actualMW ?? forecastMW)
  mwhThisHH: number;           // mwLoss / 2
  cumMWh: number;              // running sum of mwhThisHH through this row
  // Which fields came from user overrides (for UI marking).
  overridden: { lyb1TargetMW: boolean; lyb2TargetMW: boolean; actualMW: boolean };
}

/** Number of half-hour rows in the event. */
export function rowCount(config: OffloadConfig): number {
  return Math.round(config.durationHrs * 2);
}

/** Total station capacity. */
export function totalCap(config: OffloadConfig): number {
  return config.lyb1Cap + config.lyb2Cap;
}

/** Constant offload rate in MW per half-hour (same number for every row). */
export function offloadRate(config: OffloadConfig): number {
  return config.mwhReduction / config.durationHrs;
}

/**
 * Build the base schedule — no actuals, no overrides.
 * Each row represents a half-hour block labeled by its ending timestamp.
 */
export function buildSchedule(config: OffloadConfig): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const start = new Date(config.startISO).getTime();
  const rate = offloadRate(config);
  const lyb1Target = config.lyb1Cap - rate / 2;
  const lyb2Target = config.lyb2Cap - rate / 2;
  for (let i = 0; i < rowCount(config); i++) {
    const hhEndMs = start + (i + 1) * 30 * 60 * 1000;
    rows.push({
      hhEnding: new Date(hhEndMs).toISOString(),
      targetOffloadMW: rate,
      lyb1TargetMW: lyb1Target,
      lyb2TargetMW: lyb2Target,
      forecastMW: lyb1Target + lyb2Target,
    });
  }
  return rows;
}
```

- [ ] **Step 2: Add `applyActuals` to `lib/offloading/math.ts`**

Append to the same file:

```typescript
/** Map from HH-ending ISO timestamp → actual MW at the station (LYB1+LYB2 summed, 30-min avg). */
export type ActualsByHH = Map<string, number>;

/** Map from HH-ending ISO timestamp → per-row user overrides. */
export type OverridesByHH = Map<string, RowOverrides>;

/**
 * Apply AEMO actuals and user overrides to the schedule.
 * Override precedence: user override > AEMO value > null.
 * Cumulative MWh always uses the effective actual (override > AEMO > forecast fallback).
 */
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
    const aemoActual = actuals.get(row.hhEnding);
    const effectiveLyb1Target = ov.lyb1TargetMW ?? row.lyb1TargetMW;
    const effectiveLyb2Target = ov.lyb2TargetMW ?? row.lyb2TargetMW;
    const effectiveForecast = effectiveLyb1Target + effectiveLyb2Target;
    const actualMW = ov.actualMW ?? aemoActual ?? null;
    // Fall back to forecast so cumulative MWh projects forward before AEMO data arrives.
    const basisMW = actualMW ?? effectiveForecast;
    const mwLoss = cap - basisMW;
    const mwhThisHH = mwLoss / 2;
    cumMWh += mwhThisHH;
    result.push({
      ...row,
      lyb1TargetMW: effectiveLyb1Target,
      lyb2TargetMW: effectiveLyb2Target,
      forecastMW: effectiveForecast,
      actualMW,
      mwLoss,
      mwhThisHH,
      cumMWh,
      overridden: {
        lyb1TargetMW: ov.lyb1TargetMW !== undefined,
        lyb2TargetMW: ov.lyb2TargetMW !== undefined,
        actualMW: ov.actualMW !== undefined,
      },
    });
  }
  return result;
}

/** Progress state for the bottom-of-table bar. */
export type ProgressState = "onTrack" | "behind" | "over";

export function progressState(rows: ComputedRow[], config: OffloadConfig, nowMs = Date.now()): ProgressState {
  const cumTotal = rows[rows.length - 1]?.cumMWh ?? 0;
  if (cumTotal > config.mwhReduction * 1.1) return "over";
  // Linear target: expected MWh by this point in time.
  const startMs = new Date(config.startISO).getTime();
  const elapsedHrs = Math.max(0, (nowMs - startMs) / 3_600_000);
  if (elapsedHrs >= config.durationHrs) return cumTotal >= config.mwhReduction * 0.9 ? "onTrack" : "behind";
  const target = (config.mwhReduction / config.durationHrs) * elapsedHrs;
  if (cumTotal < target * 0.9) return "behind";
  return "onTrack";
}
```

- [ ] **Step 3: Create verification script `scripts/verify-offloading-math.ts`**

```typescript
/**
 * Verify math.ts against the known-good Q326 workbook values.
 * Run: npx tsx scripts/verify-offloading-math.ts
 */
import { buildSchedule, applyActuals, offloadRate, totalCap, type OffloadConfig } from "../lib/offloading/math";

// Q326 workbook inputs (from context/LYB Coal Offloading - Q326.xlsx sheet "LYB targets for offload")
const config: OffloadConfig = {
  startISO: "2025-07-01T13:00:00.000Z",  // workbook row 11 = HH ending 11:45 market; using a representative HH
  durationHrs: 4,
  mwhReduction: 1600,
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
check("offloadRate", offloadRate(config), 400);  // 1600/4

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
```

- [ ] **Step 4: Run the verification script**

Run: `npx tsx scripts/verify-offloading-math.ts`

Expected output: every line shows `✓` and final line `✓ All checks passed.` Exit code 0.

- [ ] **Step 5: Typecheck the whole repo**

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add lib/offloading/math.ts scripts/verify-offloading-math.ts
git commit -m "Add coal offloading calculation module"
```

---

## Task 2: Backend API route

**Files:**
- Create: `app/api/offloading/route.ts`

**Context:** The existing `fetchArchiveDay(report, isoDate, tables)` in `lib/nemweb/fetcher.ts` returns a day's full `DISPATCHSCADA` table (5-min `SCADAVALUE` rows per DUID). We sum LOYYB1 + LOYYB2 per 5-min interval, then bucket 6 consecutive intervals into each HH-ending average.

**Scope decision:** v1 handles past-day fetches via archives. For HHs that fall on "today" the archive isn't published yet — we return `null` for those and the user pastes values manually (matching the existing Excel workflow). A future iteration can scan `Reports/Current/Dispatch_SCADA/` for live coverage.

- [ ] **Step 1: Create `app/api/offloading/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay } from "@/lib/nemweb";

const LYB_DUIDS = ["LOYYB1", "LOYYB2"] as const;
const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  /** ISO timestamp for the half-hour ending (UTC). */
  hhEnding: string;
  /** Average LYB1 MW across the six 5-min intervals in this HH. */
  lyb1Mw: number | null;
  /** Average LYB2 MW across the six 5-min intervals in this HH. */
  lyb2Mw: number | null;
}

function isoToAemoDate(iso: string): string {
  // "2026-04-24T13:00:00.000Z" → "2026-04-24"
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Generate HH-ending ISO timestamps covering [startISO, startISO + durationHrs). */
function enumerateHHs(startISO: string, durationHrs: number): string[] {
  const out: string[] = [];
  const start = new Date(startISO).getTime();
  const rows = Math.round(durationHrs * 2);
  for (let i = 0; i < rows; i++) {
    out.push(new Date(start + (i + 1) * 30 * 60 * 1000).toISOString());
  }
  return out;
}

/** AEMO SETTLEMENTDATE is "2026/04/24 13:05:00" — convert to ISO UTC. */
function aemoToIso(aemo: string): string {
  return new Date(aemo.replace(/\//g, "-").replace(" ", "T") + "Z").toISOString();
}

/** Bucket the 5-min interval ending at `ts` into its HH-ending. 13:05→13:30; 13:30→13:30; 13:35→14:00. */
function bucketHHEnding(intervalEndISO: string): string {
  const ms = new Date(intervalEndISO).getTime();
  const thirtyMin = 30 * 60 * 1000;
  return new Date(Math.ceil(ms / thirtyMin) * thirtyMin).toISOString();
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const startISO = sp.get("start");
    const durationStr = sp.get("durationHrs");
    if (!startISO || !durationStr) {
      return NextResponse.json({ error: "missing start or durationHrs" }, { status: 400 });
    }
    const durationHrs = Number(durationStr);
    if (!Number.isFinite(durationHrs) || durationHrs < 1 || durationHrs > 24) {
      return NextResponse.json({ error: "durationHrs must be 1..24" }, { status: 400 });
    }

    const hhs = enumerateHHs(startISO, durationHrs);
    // Collect unique dates we need to fetch (past only — today is not archived yet).
    const today = todayIso();
    const datesNeeded = new Set<string>();
    for (const hh of hhs) {
      const d = isoToAemoDate(hh);
      if (d < today) datesNeeded.add(d);
    }

    // Map hhEnding → { LYB1: values[], LYB2: values[] } for averaging.
    const buckets = new Map<string, { LOYYB1: number[]; LOYYB2: number[] }>();
    for (const hh of hhs) buckets.set(hh, { LOYYB1: [], LOYYB2: [] });

    for (const date of datesNeeded) {
      const tables = await fetchArchiveDay("DISPATCHSCADA", date, SCADA_TABLES);
      const rows = tables.get("DISPATCH_UNIT_SCADA") ?? [];
      for (const row of rows) {
        const duid = row.DUID;
        if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
        const intervalEndISO = aemoToIso(row.SETTLEMENTDATE);
        const hhEnd = bucketHHEnding(intervalEndISO);
        const bucket = buckets.get(hhEnd);
        if (!bucket) continue;
        const mw = Number(row.SCADAVALUE);
        if (!Number.isFinite(mw)) continue;
        bucket[duid].push(mw);
      }
    }

    const intervals: IntervalResponse[] = hhs.map((hh) => {
      const b = buckets.get(hh)!;
      const avg = (arr: number[]) => (arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : null);
      return { hhEnding: hh, lyb1Mw: avg(b.LOYYB1), lyb2Mw: avg(b.LOYYB2) };
    });

    return NextResponse.json(
      { intervals },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (e) {
    console.error("[offloading] API error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Start the dev server**

Run: `npm run dev` (leave running in another terminal, or run in background)

- [ ] **Step 3: Test the route with a known past date**

Pick a day at least 2 days in the past to guarantee the archive is published. Example (adjust the date to match "yesterday or earlier"):

```bash
curl "http://localhost:3000/api/offloading?start=2025-07-01T03:00:00.000Z&durationHrs=4" | head -50
```

Expected: JSON with `intervals: [8 entries]`, each having `hhEnding`, `lyb1Mw`, `lyb2Mw` as numbers (roughly 380–585 MW each for LYB operating normally). Example check: each pair should sum to roughly 700–1170 MW.

If values come back as `null`, the archive for that date may not be available — try an older date.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add app/api/offloading/route.ts
git commit -m "Add /api/offloading SCADA aggregation endpoint"
```

---

## Task 3: Basic UI — inputs + read-only table

**Files:**
- Create: `components/offloading-tab.tsx`

**Context:** This task renders the inputs panel (persisted to `localStorage`) and a table of computed rows from the schedule + API data. No cell editing yet — that's Task 4.

- [ ] **Step 1: Create `components/offloading-tab.tsx` with input panel + table**

```tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  applyActuals, buildSchedule, offloadRate, totalCap, progressState,
  type OffloadConfig, type ActualsByHH, type OverridesByHH,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";

const DEFAULTS: OffloadConfig = {
  startISO: nextHalfHourISO(),
  durationHrs: 4,
  mwhReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
};

function nextHalfHourISO(): string {
  const now = new Date();
  const ms = now.getTime();
  const thirtyMin = 30 * 60 * 1000;
  return new Date(Math.ceil(ms / thirtyMin) * thirtyMin).toISOString();
}

function loadConfig(): OffloadConfig {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) } as OffloadConfig;
  } catch { return DEFAULTS; }
}

function saveConfig(cfg: OffloadConfig) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

function fmtMW(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function fmtHHLabel(iso: string): string {
  // Local HH:MM in the user's timezone — "14:30"
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
});

interface APIResponse {
  intervals: Array<{ hhEnding: string; lyb1Mw: number | null; lyb2Mw: number | null }>;
}

export function OffloadingTab() {
  const [config, setConfig] = useState<OffloadConfig>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => { setConfig(loadConfig()); setHydrated(true); }, []);
  useEffect(() => { if (hydrated) saveConfig(config); }, [config, hydrated]);

  const apiUrl = useMemo(() => {
    if (!hydrated) return null;
    const p = new URLSearchParams({ start: config.startISO, durationHrs: String(config.durationHrs) });
    return `/api/offloading?${p}`;
  }, [config.startISO, config.durationHrs, hydrated]);

  const { data } = useSWR<APIResponse>(apiUrl, fetcher, { refreshInterval: 30_000 });

  const schedule = useMemo(() => buildSchedule(config), [config]);

  const actuals: ActualsByHH = useMemo(() => {
    const map = new Map<string, number>();
    if (!data) return map;
    for (const iv of data.intervals) {
      if (iv.lyb1Mw != null && iv.lyb2Mw != null) {
        map.set(iv.hhEnding, iv.lyb1Mw + iv.lyb2Mw);
      }
    }
    return map;
  }, [data]);

  const overrides: OverridesByHH = useMemo(() => new Map(), []);  // Task 4 will populate

  const rows = useMemo(
    () => applyActuals(schedule, actuals, overrides, config),
    [schedule, actuals, overrides, config],
  );

  const cumTotal = rows[rows.length - 1]?.cumMWh ?? 0;
  const progress = progressState(rows, config);

  const update = <K extends keyof OffloadConfig>(key: K, value: OffloadConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <Field label="Event start">
              <input
                type="datetime-local"
                value={toInputValue(config.startISO)}
                onChange={(e) => update("startISO", fromInputValue(e.target.value))}
                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 font-mono"
              />
            </Field>
            <Field label="Duration (hrs)">
              <NumInput value={config.durationHrs} onChange={(v) => update("durationHrs", v)} min={1} max={24} />
            </Field>
            <Field label="MWh reduction">
              <NumInput value={config.mwhReduction} onChange={(v) => update("mwhReduction", v)} min={0} />
            </Field>
            <Field label="LYB1 capacity (MW)">
              <NumInput value={config.lyb1Cap} onChange={(v) => update("lyb1Cap", v)} min={0} />
            </Field>
            <Field label="LYB2 capacity (MW)">
              <NumInput value={config.lyb2Cap} onChange={(v) => update("lyb2Cap", v)} min={0} />
            </Field>
          </div>
          <div className="text-[11px] text-zinc-400 flex gap-6">
            <span>Offload rate: <span className="text-zinc-200 font-mono">{offloadRate(config).toFixed(1)} MW/hh</span></span>
            <span>Total capacity: <span className="text-zinc-200 font-mono">{totalCap(config)} MW</span></span>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-white/5">
                <TableHead>HH ending</TableHead>
                <TableHead className="text-right">Target offload</TableHead>
                <TableHead className="text-right">LYB1 target</TableHead>
                <TableHead className="text-right">LYB2 target</TableHead>
                <TableHead className="text-right">Forecast</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead className="text-right">MW Loss</TableHead>
                <TableHead className="text-right">MWh / HH</TableHead>
                <TableHead className="text-right">Cum MWh</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.hhEnding} className="border-white/5 font-mono text-xs">
                  <TableCell>{fmtHHLabel(r.hhEnding)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.targetOffloadMW)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.lyb1TargetMW)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.lyb2TargetMW)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.forecastMW)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.actualMW)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.mwLoss)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.mwhThisHH)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.cumMWh)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="p-3 text-xs flex items-center gap-3">
            <span className="text-zinc-400">Cumulative:</span>
            <span className="font-mono text-zinc-100">{cumTotal.toFixed(1)} / {config.mwhReduction} MWh</span>
            <span className={`ml-auto text-[11px] ${progress === "over" ? "text-red-400" : progress === "behind" ? "text-amber-400" : "text-emerald-400"}`}>
              {progress === "over" ? "over target" : progress === "behind" ? "behind schedule" : "on track"}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function NumInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
      min={min}
      max={max}
      className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 font-mono w-full"
    />
  );
}

/** "2026-04-24T13:00:00.000Z" → "2026-04-24T13:00" (local) for datetime-local input. */
function toInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-04-24T13:00" (local) → "2026-04-24T13:00:00.000Z" (UTC ISO). */
function fromInputValue(local: string): string {
  return new Date(local).toISOString();
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output, exit code 0. If there are errors, fix them before committing.

- [ ] **Step 3: Commit**

```bash
git add components/offloading-tab.tsx
git commit -m "Add OffloadingTab component with inputs and read-only table"
```

---

## Task 4: Cell overrides + spreadsheet-style paste

**Files:**
- Modify: `components/offloading-tab.tsx`

**Context:** Users must be able to click any of the `Actual`, `LYB1 target`, `LYB2 target` cells to type a value. Pasting a block of tab/newline-separated values (Excel copy) should fill multiple cells starting from the clicked cell. Each overridden cell shows a revert (↺) button to clear that override back to the AEMO / default value.

- [ ] **Step 1: Add override state + EditableCell component**

Modify `components/offloading-tab.tsx`. Replace the line `const overrides: OverridesByHH = useMemo(() => new Map(), []);` with real state, and add helper components/handlers. The new sections are:

```tsx
// Near the top of OffloadingTab, replace the dummy overrides with:
const [overridesMap, setOverridesMap] = useState<OverridesByHH>(() => new Map());
const overrides = overridesMap;

const setOverride = (hhEnding: string, field: "lyb1TargetMW" | "lyb2TargetMW" | "actualMW", value: number | undefined) => {
  setOverridesMap((prev) => {
    const next = new Map(prev);
    const row = { ...(next.get(hhEnding) ?? {}) };
    if (value === undefined) delete row[field];
    else row[field] = value;
    if (Object.keys(row).length === 0) next.delete(hhEnding);
    else next.set(hhEnding, row);
    return next;
  });
};

/** Paste handler — parses clipboard text as tab/newline rows and fills cells starting at (rowIdx, field). */
const handlePaste = (rowIdx: number, field: "lyb1TargetMW" | "lyb2TargetMW" | "actualMW", text: string) => {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length);
  const fields: Array<"lyb1TargetMW" | "lyb2TargetMW" | "actualMW"> = ["lyb1TargetMW", "lyb2TargetMW", "actualMW"];
  const startColIdx = fields.indexOf(field);
  setOverridesMap((prev) => {
    const next = new Map(prev);
    lines.forEach((line, lineIdx) => {
      const cells = line.split("\t");
      cells.forEach((raw, colIdx) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        const targetRowIdx = rowIdx + lineIdx;
        const targetField = fields[startColIdx + colIdx];
        const targetRow = rows[targetRowIdx];
        if (!targetRow || !targetField) return;
        const existing = { ...(next.get(targetRow.hhEnding) ?? {}) };
        existing[targetField] = n;
        next.set(targetRow.hhEnding, existing);
      });
    });
    return next;
  });
};
```

And replace the three `<TableCell className="text-right">...</TableCell>` entries for LYB1 target, LYB2 target, and Actual with `<EditableCell />` usages:

```tsx
<EditableCell
  value={r.lyb1TargetMW}
  isOverride={r.overridden.lyb1TargetMW}
  onCommit={(v) => setOverride(r.hhEnding, "lyb1TargetMW", v)}
  onRevert={() => setOverride(r.hhEnding, "lyb1TargetMW", undefined)}
  onPaste={(text) => handlePaste(rows.indexOf(r), "lyb1TargetMW", text)}
/>
<EditableCell
  value={r.lyb2TargetMW}
  isOverride={r.overridden.lyb2TargetMW}
  onCommit={(v) => setOverride(r.hhEnding, "lyb2TargetMW", v)}
  onRevert={() => setOverride(r.hhEnding, "lyb2TargetMW", undefined)}
  onPaste={(text) => handlePaste(rows.indexOf(r), "lyb2TargetMW", text)}
/>
<EditableCell
  value={r.actualMW}
  isOverride={r.overridden.actualMW}
  onCommit={(v) => setOverride(r.hhEnding, "actualMW", v)}
  onRevert={() => setOverride(r.hhEnding, "actualMW", undefined)}
  onPaste={(text) => handlePaste(rows.indexOf(r), "actualMW", text)}
/>
```

Then add the `EditableCell` component at the bottom of the file:

```tsx
function EditableCell({
  value, isOverride, onCommit, onRevert, onPaste,
}: {
  value: number | null;
  isOverride: boolean;
  onCommit: (v: number) => void;
  onRevert: () => void;
  onPaste: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const display = value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);

  const startEdit = () => { setDraft(display === "—" ? "" : display); setEditing(true); };
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(n);
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  return (
    <TableCell
      className={`text-right relative cursor-text ${isOverride ? "border-l-2 border-l-blue-500" : ""}`}
      onClick={(e) => { if (!editing) { e.stopPropagation(); startEdit(); } }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") cancel();
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (text.includes("\t") || text.includes("\n")) {
              e.preventDefault();
              onPaste(text);
              setEditing(false);
            }
          }}
          className="w-full bg-zinc-950 border border-blue-500 rounded px-1 py-0 text-right font-mono text-xs text-zinc-100 outline-none"
        />
      ) : (
        <>
          <span>{display}</span>
          {isOverride && (
            <button
              onClick={(e) => { e.stopPropagation(); onRevert(); }}
              className="ml-1 opacity-40 hover:opacity-100 text-[10px]"
              title="Revert to AEMO / default"
            >
              ↺
            </button>
          )}
        </>
      )}
    </TableCell>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output. Fix any errors before moving on.

- [ ] **Step 3: Test in browser**

With dev server running, navigate to the Coal Offloading tab (Task 5 wires it into the sidebar — until then, test by temporarily rendering `<OffloadingTab />` in `app/page.tsx`, or skip this step and test after Task 5).

Verify:
- Clicking an Actual cell opens an input; typing a number and pressing Enter commits.
- The committed cell shows a blue left border and a revert `↺` icon.
- Clicking `↺` restores the AEMO / blank value.
- Copy 2 cells from Excel (values separated by a tab) and paste into a cell — both cells update.
- Copy a vertical block from Excel (values separated by newlines) — rows fill downward.

- [ ] **Step 4: Commit**

```bash
git add components/offloading-tab.tsx
git commit -m "Wire up override + spreadsheet-style paste on OffloadingTab cells"
```

---

## Task 5: Navigation wiring + copy-summary action

**Files:**
- Modify: `components/side-nav.tsx`
- Modify: `app/page.tsx`
- Modify: `components/offloading-tab.tsx` (add Copy Summary button)

- [ ] **Step 1: Add the nav entry**

In `components/side-nav.tsx`:

First, add `"offloading"` to the `NavTabId` union (after `"startcost"`, before `"braemar"`):

```typescript
  | "startcost"
  | "offloading"
  | "braemar"
```

Import `Flame` from lucide-react at the top (alongside the existing `Flag, Factory, ...` imports — find that import line and add `Flame`).

Then add the nav item in the Tools section, after BR Start:

```typescript
      { id: "startcost", label: "Braemar Start", icon: Flag },
      { id: "offloading", label: "Coal Offloading", icon: Flame },
      { id: "braemar", label: "Braemar Revenue", icon: Factory, gated: true },
```

- [ ] **Step 2: Wire the tab content in `app/page.tsx`**

Add `"offloading"` to the `TabId` union (around line 168-171):

```typescript
type TabId =
  | "prices" | "demand" | "interconnectors" | "sensitivities" | "actuals"
  | "market-nem"
  | "spikes" | "startcost" | "offloading" | "braemar" | "bdl";
```

Import the component at the top of `app/page.tsx` (alongside other component imports):

```typescript
import { OffloadingTab } from "@/components/offloading-tab";
```

Then add the TabsContent block after the startcost one and before the Revenue tabs. Find:

```tsx
        <TabsContent value="startcost">
          <StartCostTab />
        </TabsContent>
```

Add directly after it:

```tsx
        <TabsContent value="offloading" className="mt-4">
          <OffloadingTab />
        </TabsContent>
```

- [ ] **Step 3: Add Copy Summary button to `OffloadingTab`**

In `components/offloading-tab.tsx`, inside the progress bar row (the `<div className="p-3 text-xs flex items-center gap-3">`), add a Copy button. Replace that div with:

```tsx
          <div className="p-3 text-xs flex items-center gap-3">
            <span className="text-zinc-400">Cumulative:</span>
            <span className="font-mono text-zinc-100">{cumTotal.toFixed(1)} / {config.mwhReduction} MWh</span>
            <span className={`text-[11px] ${progress === "over" ? "text-red-400" : progress === "behind" ? "text-amber-400" : "text-emerald-400"}`}>
              {progress === "over" ? "over target" : progress === "behind" ? "behind schedule" : "on track"}
            </span>
            <button
              onClick={() => {
                const startLabel = fmtHHLabel(config.startISO);
                const endLabel = fmtHHLabel(new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString());
                const forecastMW = rows[0]?.forecastMW ?? 0;
                const text = `Coal offloading event — LYB reducing to ~${forecastMW.toFixed(0)} MW from HH ${startLabel} to ${endLabel}. Target ${config.mwhReduction} MWh reduction.`;
                void navigator.clipboard.writeText(text);
              }}
              className="ml-auto px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-[11px]"
            >
              Copy summary
            </button>
          </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 5: Test in browser**

With dev server running:

1. Reload the page, enter the site password if prompted.
2. Click the "Coal Offloading" entry in the sidebar (flame icon, under Tools).
3. Verify the inputs panel shows sensible defaults (Duration 4, MWh reduction 1600, LYB1/LYB2 cap 585 each, offload rate 400 MW/hh, total capacity 1170 MW).
4. Change Duration to 6 — the table should show 12 rows, and the offload rate should drop to `1600 / 6 ≈ 266.7` MW/hh.
5. Pick a past event start (e.g., 2 days ago, 03:00 UTC) — the Actual column should populate with AEMO values within ~5 seconds.
6. Click an Actual cell, type a value, press Enter — cell commits with blue border and `↺` icon.
7. Click `↺` — cell reverts to AEMO value.
8. Click "Copy summary" — paste into any text editor; should read: `Coal offloading event — LYB reducing to ~770 MW from HH 13:30 to 17:30. Target 1600 MWh reduction.` (times depend on your start).
9. Reload the page — inputs persist (localStorage).

- [ ] **Step 6: Commit**

```bash
git add components/offloading-tab.tsx components/side-nav.tsx app/page.tsx
git commit -m "Wire Coal Offloading tab into sidebar and add copy summary"
```

---

## Done — feature ready for review

After Task 5 the feature is fully functional. Remaining nice-to-haves (explicitly out of scope for v1):

- Current-day auto-fill (scan `/Reports/Current/Dispatch_SCADA/` for in-flight events)
- Event history (persist past events server-side)
- Chart of cumulative target vs actual
- Automatic notification parsing from the Coal Supply Shortfall Notification text
