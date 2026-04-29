# Coal Offloading 5-min Sensitivity & Dynamic Target Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the offloading tab from 30-min to 5-min row resolution, recompute `Target MW` dynamically each row from cumulative MWh delivered, and remove the five right-most columns plus their gas / per-unit-actual editing UI.

**Architecture:** Schedule construction stays in `lib/offloading/math.ts` (now 5-min rows; `targetOffloadMW` and the bid-target fields move from `ScheduleRow` to `ComputedRow` because they depend on cumulative state). The API at `app/api/offloading/route.ts` returns one entry per native AEMO 5-min interval (no HH bucketing). The component drops the right-side columns and per-row override plumbing.

**Tech Stack:** Next.js 16, React 19, TypeScript, SWR, Tailwind. No test framework — verification via `scripts/verify-offloading-math.ts` (run with `npx tsx`) plus manual UI check.

**Renaming convention:** `hhEnding` → `intervalEnding` everywhere (column label is changing anyway; keeping the old name would actively mislead future readers). Storage key `nem-offloading-config` unchanged.

**Spec:** `docs/superpowers/specs/2026-04-29-offloading-5min-dynamic-design.md`

---

## File Structure

- `lib/offloading/math.ts` — modify: 5-min row stepping, dynamic target in `applyActuals`, drop gas / overrides
- `app/api/offloading/route.ts` — modify: native 5-min intervals, response shape changes `hhEnding` → `intervalEnding`
- `components/offloading-tab.tsx` — modify: column removal, 5-min rounding, drop EditableCell wiring, rename references
- `scripts/verify-offloading-math.ts` — modify: rewrite checks for 5-min cadence and dynamic target

No new files.

---

## Task 1: Update math types and constants

**Files:**
- Modify: `lib/offloading/math.ts`

- [ ] **Step 1: Replace the type definitions and helpers**

Open `lib/offloading/math.ts` and replace the entire file with:

```typescript
// lib/offloading/math.ts

/** All schedule rows are 5-min ending intervals to match AEMO dispatch cadence. */
export const INTERVAL_MIN = 5;

export interface OffloadConfig {
  /** ISO timestamp for the first 5-min interval ending. */
  startISO: string;
  /** Event length in hours (integer, 1–24). */
  durationHrs: number;
  /** Target total MWh reduction across the whole event. */
  mwReduction: number;
  /** Unit 1 registered capacity in MW. */
  lyb1Cap: number;
  /** Unit 2 registered capacity in MW. */
  lyb2Cap: number;
}

/** One 5-min row in the offloading table — pre-computed (no actuals applied yet). */
export interface ScheduleRow {
  intervalEnding: string;     // ISO timestamp
  /** Target cumulative MWh reduction by end of this interval (negative — running deficit target). */
  targetCumMWh: number;
}

/** Row after AEMO actuals applied + dynamic target computed. */
export interface ComputedRow extends ScheduleRow {
  /** Dynamic MW target for this 5-min interval (catch-up redistributes overshoot/undershoot). */
  targetOffloadMW: number;
  /** Bid target per unit for this row, clamped >= 0. */
  lyb1TargetMW: number;
  lyb2TargetMW: number;
  /** Sum of bid targets — what the station should produce in this interval. */
  forecastMW: number;
  /** AEMO actuals when both units have a reading; null otherwise. */
  lyb1Actual: number | null;
  lyb2Actual: number | null;
  /** Sum of unit actuals (no gas subtraction). null if either unit missing. */
  totalActualMW: number | null;
  /** cap - basisMW where basis is totalActualMW ?? forecastMW. */
  mwLoss: number;
  /** mwLoss * (INTERVAL_MIN / 60). */
  mwhThisInterval: number;
  /** Running sum of mwhThisInterval through this row. */
  cumMWh: number;
}

/** Per-interval AEMO actual MW split by unit. Map key is the intervalEnding ISO. */
export type ActualsByInterval = Map<string, { lyb1: number; lyb2: number }>;

/** Number of 5-min rows in the event. */
export function rowCount(config: OffloadConfig): number {
  return Math.round(config.durationHrs * (60 / INTERVAL_MIN));
}

/** Total station capacity. */
export function totalCap(config: OffloadConfig): number {
  return config.lyb1Cap + config.lyb2Cap;
}

/** Initial offload rate per row (MW). Equals mwReduction / durationHrs because cum delivered = 0. */
export function offloadRate(config: OffloadConfig): number {
  return config.mwReduction / config.durationHrs;
}

/** Build the bare timeline — no actuals, no targets yet. */
export function buildSchedule(config: OffloadConfig): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const start = new Date(config.startISO).getTime();
  const stepMs = INTERVAL_MIN * 60 * 1000;
  const ratePerHour = config.mwReduction / config.durationHrs;
  const mwhPerInterval = ratePerHour * (INTERVAL_MIN / 60);
  const n = rowCount(config);
  for (let i = 0; i < n; i++) {
    rows.push({
      intervalEnding: new Date(start + i * stepMs).toISOString(),
      targetCumMWh: -((i + 1) * mwhPerInterval),
    });
  }
  return rows;
}

/** Apply AEMO actuals + recompute the dynamic target per row.
 *  For each row: target = (mwReduction - cumDeliveredBefore) / remainingHours.
 *  Last row uses target = remainingMWh / (INTERVAL_MIN/60). Target is clamped to [0, totalCap]. */
export function applyActuals(
  schedule: ScheduleRow[],
  actuals: ActualsByInterval,
  config: OffloadConfig,
): ComputedRow[] {
  const cap = totalCap(config);
  const result: ComputedRow[] = [];
  const intervalHours = INTERVAL_MIN / 60;
  let cumMWh = 0;

  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];
    const aemo = actuals.get(row.intervalEnding);

    const remainingRows = schedule.length - i;
    const remainingHours = remainingRows * intervalHours;
    const remainingMWh = config.mwReduction - cumMWh;
    const rawTarget =
      remainingHours > 0 ? remainingMWh / remainingHours : remainingMWh / intervalHours;
    const targetOffloadMW = Math.max(0, Math.min(cap, rawTarget));

    const lyb1Target = Math.max(0, config.lyb1Cap - targetOffloadMW / 2);
    const lyb2Target = Math.max(0, config.lyb2Cap - targetOffloadMW / 2);
    const forecastMW = lyb1Target + lyb2Target;

    const lyb1Actual = aemo?.lyb1 ?? null;
    const lyb2Actual = aemo?.lyb2 ?? null;
    const totalActualMW =
      lyb1Actual != null && lyb2Actual != null ? lyb1Actual + lyb2Actual : null;

    const basisMW = totalActualMW ?? forecastMW;
    const mwLoss = cap - basisMW;
    const mwhThisInterval = mwLoss * intervalHours;
    cumMWh += mwhThisInterval;

    result.push({
      ...row,
      targetOffloadMW,
      lyb1TargetMW: lyb1Target,
      lyb2TargetMW: lyb2Target,
      forecastMW,
      lyb1Actual,
      lyb2Actual,
      totalActualMW,
      mwLoss,
      mwhThisInterval,
      cumMWh,
    });
  }
  return result;
}

/** Progress state for status reporting (kept for parity — not currently rendered). */
export type ProgressState = "onTrack" | "behind" | "over";

export function progressState(
  rows: ComputedRow[],
  config: OffloadConfig,
  nowMs = Date.now(),
): ProgressState {
  const cumTotal = rows[rows.length - 1]?.cumMWh ?? 0;
  if (cumTotal > config.mwReduction * 1.1) return "over";
  const startMs = new Date(config.startISO).getTime();
  const elapsedHrs = Math.max(0, (nowMs - startMs) / 3_600_000);
  if (elapsedHrs >= config.durationHrs)
    return cumTotal >= config.mwReduction * 0.9 ? "onTrack" : "behind";
  const target = (config.mwReduction / config.durationHrs) * elapsedHrs;
  if (cumTotal < target * 0.9) return "behind";
  return "onTrack";
}
```

This is a complete file replacement (the old `RowOverrides`, `OverridesByHH`, gas fields, and the old `ScheduleRow`/`ComputedRow` shapes are all gone).

- [ ] **Step 2: Type-check the file in isolation**

Run: `npx tsc --noEmit lib/offloading/math.ts`
Expected: no output (success). The component and verify script will be broken at this point — fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add lib/offloading/math.ts
git commit -m "Offloading: 5-min rows + dynamic catch-up target in math.ts"
```

---

## Task 2: Rewrite the verification script

**Files:**
- Modify: `scripts/verify-offloading-math.ts`

- [ ] **Step 1: Replace the file with new checks**

Replace the entire contents of `scripts/verify-offloading-math.ts` with:

```typescript
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
```

- [ ] **Step 2: Run the verify script**

Run: `npx tsx scripts/verify-offloading-math.ts`
Expected: all OK lines printed, ends with `All checks passed.`

If any check fails: re-read the math against Task 1 — common bugs are off-by-one in `remainingRows`, sign flips on `targetCumMWh`, or forgetting to clamp.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-offloading-math.ts
git commit -m "Offloading: rewrite verify script for 5-min + dynamic target"
```

---

## Task 3: Update the API route for 5-min native intervals

**Files:**
- Modify: `app/api/offloading/route.ts`

- [ ] **Step 1: Replace the route file**

Replace the entire contents of `app/api/offloading/route.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { fetchArchiveDay } from "@/lib/nemweb";

const SCADA_TABLES = new Set(["DISPATCH_UNIT_SCADA"]);

interface IntervalResponse {
  /** ISO timestamp for the 5-min interval ending (UTC). */
  intervalEnding: string;
  /** LYB1 MW for this 5-min interval. */
  lyb1Mw: number | null;
  /** LYB2 MW for this 5-min interval. */
  lyb2Mw: number | null;
}

const INTERVAL_MIN = 5;

function isoToAemoDate(iso: string): string {
  // "2026-04-24T13:00:00.000Z" → "2026-04-24"
  return iso.slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Generate 5-min interval-ending ISO timestamps covering [startISO, startISO + durationHrs). */
function enumerateIntervals(startISO: string, durationHrs: number): string[] {
  const out: string[] = [];
  const start = new Date(startISO).getTime();
  const rows = Math.round(durationHrs * (60 / INTERVAL_MIN));
  const stepMs = INTERVAL_MIN * 60 * 1000;
  for (let i = 0; i < rows; i++) {
    out.push(new Date(start + i * stepMs).toISOString());
  }
  return out;
}

/** AEMO SETTLEMENTDATE is "2026/04/24 13:05:00" — convert to ISO UTC. */
function aemoToIso(aemo: string): string {
  return new Date(aemo.replace(/\//g, "-").replace(" ", "T") + "Z").toISOString();
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

    const intervals = enumerateIntervals(startISO, durationHrs);
    const wanted = new Set(intervals);

    const today = todayIso();
    const datesNeeded = new Set<string>();
    for (const iv of intervals) {
      const d = isoToAemoDate(iv);
      if (d < today) datesNeeded.add(d);
    }

    // Map intervalEnding → { LYB1, LYB2 } MW (latest seen wins; AEMO 5-min is unique).
    const buckets = new Map<string, { LOYYB1: number | null; LOYYB2: number | null }>();
    for (const iv of intervals) buckets.set(iv, { LOYYB1: null, LOYYB2: null });

    const results = await Promise.allSettled(
      Array.from(datesNeeded).map((date) =>
        fetchArchiveDay("DISPATCHSCADA", date, SCADA_TABLES).then((tables) => ({ date, tables })),
      ),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn(
          "[offloading] SCADA fetch failed:",
          r.reason instanceof Error ? r.reason.message : r.reason,
        );
        continue;
      }
      const rows = r.value.tables.get("DISPATCH_UNIT_SCADA") ?? [];
      for (const row of rows) {
        const duid = row.DUID;
        if (duid !== "LOYYB1" && duid !== "LOYYB2") continue;
        const intervalEndISO = aemoToIso(row.SETTLEMENTDATE);
        if (!wanted.has(intervalEndISO)) continue;
        const mw = Number(row.SCADAVALUE);
        if (!Number.isFinite(mw)) continue;
        const bucket = buckets.get(intervalEndISO)!;
        bucket[duid] = mw;
      }
    }

    const response: IntervalResponse[] = intervals.map((iv) => {
      const b = buckets.get(iv)!;
      return { intervalEnding: iv, lyb1Mw: b.LOYYB1, lyb2Mw: b.LOYYB2 };
    });

    return NextResponse.json(
      { intervals: response },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (e) {
    console.error("[offloading] API error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "unknown" }, { status: 500 });
  }
}
```

Key differences vs old route:
- `enumerateHHs` → `enumerateIntervals` (5-min step).
- `bucketHHEnding` removed — AEMO `SETTLEMENTDATE` aligns to 5-min interval-endings already, so we match by exact equality against `wanted`.
- Buckets now hold a single MW value per unit (not arrays to average).
- Response key is `intervalEnding` (not `hhEnding`).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: errors only in `components/offloading-tab.tsx` (still using old shape — fixed in Task 4). The route itself should be clean.

- [ ] **Step 3: Commit**

```bash
git add app/api/offloading/route.ts
git commit -m "Offloading: API returns native 5-min intervals"
```

---

## Task 4: Update the component for 5-min rows and column removal

**Files:**
- Modify: `components/offloading-tab.tsx`

- [ ] **Step 1: Replace imports and helpers at the top**

In `components/offloading-tab.tsx`, replace everything from the top of the file through and including the `APIResponse` interface declaration (the block ending just before `export function OffloadingTab`) with:

```typescript
"use client";

import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info, Copy, Check } from "lucide-react";
import {
  applyActuals, buildSchedule, offloadRate, totalCap, INTERVAL_MIN,
  type ActualsByInterval, type OffloadConfig,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";

const INPUT_CLS =
  "bg-zinc-950 border border-zinc-700 rounded h-8 px-2 text-zinc-200 font-mono text-xs w-full outline-none focus:border-zinc-500";

/** Data provenance color coding. */
const SRC = {
  CALC:  "bg-orange-500/10",
  INPUT: "bg-yellow-400/30",
  AEMO:  "bg-blue-500/15",
} as const;
const HEADER_SRC = {
  CALC:  "bg-orange-500/25",
  INPUT: "bg-yellow-400/50",
  AEMO:  "bg-blue-500/30",
} as const;

const DEFAULTS: OffloadConfig = {
  startISO: nextIntervalISO(),
  durationHrs: 4,
  mwReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
};

function nextIntervalISO(): string {
  const now = new Date();
  const ms = now.getTime();
  const stepMs = INTERVAL_MIN * 60 * 1000;
  return new Date(Math.ceil(ms / stepMs) * stepMs).toISOString();
}

function loadConfig(): OffloadConfig {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<OffloadConfig> & { mwhReduction?: number };
    if (parsed.mwReduction == null && parsed.mwhReduction != null) {
      parsed.mwReduction = parsed.mwhReduction;
      delete parsed.mwhReduction;
    }
    const merged = { ...DEFAULTS, ...parsed } as OffloadConfig;
    // Snap any stored startISO that doesn't sit on a 5-min boundary forward to the next 5-min.
    const t = new Date(merged.startISO).getTime();
    const stepMs = INTERVAL_MIN * 60 * 1000;
    if (t % stepMs !== 0) merged.startISO = new Date(Math.ceil(t / stepMs) * stepMs).toISOString();
    return merged;
  } catch { return DEFAULTS; }
}

function saveConfig(cfg: OffloadConfig) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

function fmtMW(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function fmtSignedMWh(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function fmtIntervalLabel(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
});

interface APIResponse {
  intervals: Array<{ intervalEnding: string; lyb1Mw: number | null; lyb2Mw: number | null }>;
}
```

- [ ] **Step 2: Replace the OffloadingTab component body**

Replace the entire `export function OffloadingTab() { ... }` block with:

```typescript
export function OffloadingTab() {
  const [config, setConfig] = useState<OffloadConfig>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const loaded = loadConfig();
    loaded.startISO = withDate(loaded.startISO, todayDateStr());
    setConfig(loaded);
    setHydrated(true);
  }, []);
  useEffect(() => { if (hydrated) saveConfig(config); }, [config, hydrated]);

  const apiUrl = useMemo(() => {
    if (!hydrated) return null;
    const p = new URLSearchParams({ start: config.startISO, durationHrs: String(config.durationHrs) });
    return `/api/offloading?${p}`;
  }, [config.startISO, config.durationHrs, hydrated]);

  const { data } = useSWR<APIResponse>(apiUrl, fetcher, { refreshInterval: 30_000 });

  const schedule = useMemo(() => buildSchedule(config), [config]);

  const actuals: ActualsByInterval = useMemo(() => {
    const map = new Map<string, { lyb1: number; lyb2: number }>();
    if (!data) return map;
    for (const iv of data.intervals) {
      if (iv.lyb1Mw != null && iv.lyb2Mw != null) {
        map.set(iv.intervalEnding, { lyb1: iv.lyb1Mw, lyb2: iv.lyb2Mw });
      }
    }
    return map;
  }, [data]);

  const rows = useMemo(
    () => applyActuals(schedule, actuals, config),
    [schedule, actuals, config],
  );

  const update = <K extends keyof OffloadConfig>(key: K, value: OffloadConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const summaryText = useMemo(() => {
    const startLabel = fmtTimeOnly(config.startISO);
    const endISO = new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString();
    const endLabel = fmtTimeOnly(endISO);
    const forecastMW = rows[0]?.forecastMW ?? 0;
    return `Coal offloading event — LYB reducing to ~${forecastMW.toFixed(0)} MW from interval ${startLabel} to ${endLabel}. Target ${config.mwReduction.toFixed(0)} MWh reduction.`;
  }, [config, rows]);

  return (
    <div className="space-y-4">
      <SummaryCard text={summaryText} />
      <DebugLegend />

      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-7 gap-2 text-xs">
            <Field label="Start date">
              <input
                type="date"
                value={toDateInput(config.startISO)}
                onChange={(e) => update("startISO", withDate(config.startISO, e.target.value))}
                onClick={(e) => {
                  const el = e.currentTarget;
                  if (typeof el.showPicker === "function") el.showPicker();
                }}
                className={`${INPUT_CLS} ${SRC.INPUT} [color-scheme:dark] cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100`}
              />
            </Field>
            <Field label="Start time" className="md:col-span-2">
              <TimePicker
                value={toTimeInput(config.startISO)}
                onChange={(hhmm24) => update("startISO", withTime(config.startISO, hhmm24))}
              />
            </Field>
            <Field label="Duration (hrs)" tooltip="Input the total duration in hours of the offloading event.">
              <NumInput className={SRC.INPUT} value={config.durationHrs} onChange={(v) => update("durationHrs", v)} min={1} max={99} maxDigits={2} />
            </Field>
            <Field label="Total MW reduction" tooltip="Input the total amount of MW needed to offload across the whole event.">
              <NumInput className={SRC.INPUT} value={config.mwReduction} onChange={(v) => update("mwReduction", v)} min={0} />
            </Field>
            <Field label="LYB1 capacity (MW)">
              <NumInput className={SRC.INPUT} value={config.lyb1Cap} onChange={(v) => update("lyb1Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field label="LYB2 capacity (MW)">
              <NumInput className={SRC.INPUT} value={config.lyb2Cap} onChange={(v) => update("lyb2Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
          </div>
          <div className="text-[11px] text-zinc-400 flex gap-6">
            <span>Initial offload rate: <span className="text-zinc-200 font-mono">{offloadRate(config).toFixed(1)} MW</span></span>
            <span>Total capacity: <span className="text-zinc-200 font-mono">{totalCap(config)} MW</span></span>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5">
                  <TableHead className={`whitespace-nowrap ${HEADER_SRC.CALC}`}>Interval ending<br/><span className="text-[9px] font-normal text-zinc-500">Market Time</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Target MW<br/><span className="text-[9px] font-normal text-zinc-500">/ 5 min</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Target<br/><span className="text-[9px] font-normal text-zinc-500">Offload MWh</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Forecast<br/><span className="text-[9px] font-normal text-zinc-500">MW</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.AEMO}`}>Actual<br/><span className="text-[9px] font-normal text-zinc-500">MW</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>MW Loss</TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Act Offload<br/><span className="text-[9px] font-normal text-zinc-500">MWh</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Cum MWh<br/><span className="text-[9px] font-normal text-zinc-500">Loss</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap border-l border-white/10 ${HEADER_SRC.CALC}`}>LYB1<br/><span className="text-[9px] font-normal text-zinc-500">Bid target</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>LYB2<br/><span className="text-[9px] font-normal text-zinc-500">Bid target</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Total<br/><span className="text-[9px] font-normal text-zinc-500">bid</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.intervalEnding} className="border-white/5 font-mono text-xs">
                    <TableCell className={`whitespace-nowrap ${SRC.CALC}`}>{fmtIntervalLabel(r.intervalEnding)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.targetOffloadMW)}</TableCell>
                    <TableCell className={`text-right text-zinc-400 ${SRC.CALC}`}>{fmtSignedMWh(r.targetCumMWh)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.forecastMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.AEMO} ${r.totalActualMW == null ? "italic text-zinc-500" : ""}`}>
                      {fmtMW(r.totalActualMW ?? r.forecastMW)}
                    </TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.mwLoss)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.mwhThisInterval)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.cumMWh)}</TableCell>
                    <TableCell className={`text-right border-l border-white/10 ${SRC.CALC}`}>{fmtMW(r.lyb1TargetMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.lyb2TargetMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.lyb1TargetMW + r.lyb2TargetMW)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Delete the unused `EditableCell` component and `OverrideField` type**

Scroll to the bottom of `components/offloading-tab.tsx` and delete the entire `function EditableCell(...) { ... }` block. Also delete any remaining references to `OverrideField` and `OVERRIDE_FIELDS` if they survived the earlier replacement.

`DebugLegend`, `SummaryCard`, `Field`, `TimePicker`, `NumInput`, `pad2`, `todayDateStr`, `toDateInput`, `toTimeInput`, `withDate`, `withTime` all stay as-is.

Update `DebugLegend` example text to drop the references to gas/Less gas. Find the `<Row bg={SRC.INPUT}` line in `DebugLegend` and change its `example` prop from `"e.g. Duration, Total MW reduction, LYB capacities, Less gas"` to `"e.g. Duration, Total MW reduction, LYB capacities"`.

- [ ] **Step 4: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: clean. If there are residual errors, they are almost certainly stragglers referencing `lyb1Gas`, `hhEnding`, `OverridesByHH`, `RowOverrides`, or the deleted columns — fix each one.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no errors. Warnings about unused imports inside `offloading-tab.tsx` (e.g. `Copy`, `Check` — they should still be used by `SummaryCard`) get fixed by removing the unused import.

- [ ] **Step 6: Commit**

```bash
git add components/offloading-tab.tsx
git commit -m "Offloading: 5-min rows, dynamic target, drop right-side actual/gas columns"
```

---

## Task 5: Manual UI verification

**Files:** none — runtime check.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server starts, prints local URL (typically `http://localhost:3000`).

- [ ] **Step 2: Open the offloading tab**

Browse to the offloading tab in the app (whatever route hosts it — start at `http://localhost:3000` and navigate). Confirm:
- Table renders with **48 rows** for the default 4-hour event.
- Row timestamps step **5 minutes** apart.
- Eleven columns visible: `Interval ending`, `Target MW`, `Target Offload MWh`, `Forecast MW`, `Actual MW`, `MW Loss`, `Act Offload MWh`, `Cum MWh Loss`, `LYB1 Bid target`, `LYB2 Bid target`, `Total bid`.
- The five removed columns are gone (`LYB1 actual`, `Less gas LYB1`, `LYB2 actual`, `Less gas LYB2`, `Total actual`).
- DebugLegend tooltip no longer mentions "Less gas".

- [ ] **Step 3: Set a past start time and check AEMO data populates**

In the config card, set the start date to **yesterday** (or any past date you have AEMO data for) and time to a known interval. Expected:
- `Actual MW` column populates with non-italic values (blue background) for past intervals.
- `MW Loss`, `Act Offload MWh`, `Cum MWh Loss` all reflect the AEMO basis.
- `Cum MWh Loss` of the final row is close to (but not necessarily exactly) `mwReduction` because actuals and the dynamic target reconverge.

- [ ] **Step 4: Verify dynamic target behaviour**

Set the start to a past date where you can see actuals well above and below forecast. Watch `Target MW`:
- After rows where `Actual MW` was below the per-interval forecast (i.e. unit produced more than expected, less reduction delivered), `Target MW` for subsequent rows should be **higher**.
- After rows where `Actual MW` was above forecast, `Target MW` should be **lower**.

If targets stay flat row-to-row when actuals diverge from forecast, the dynamic catch-up isn't wiring through — re-check Task 1's `applyActuals`.

- [ ] **Step 5: Verify summary text**

Confirm the top-of-page summary card reads sensibly: "Coal offloading event — LYB reducing to ~770 MW from interval HH:MM to HH:MM. Target 1600 MWh reduction." (numbers vary with config). Click `Copy`, confirm clipboard shows the same text.

- [ ] **Step 6: Stop the dev server**

Ctrl-C in the terminal running `npm run dev`.

- [ ] **Step 7: Commit (if any small fixups were made during manual check)**

If steps 2–5 surfaced bugs that you fixed, commit those fixes now. If everything was clean, no commit is needed for this task.

---

## Done check

- `lib/offloading/math.ts` exports `INTERVAL_MIN`, `ActualsByInterval`, no `RowOverrides`, no gas fields.
- `app/api/offloading/route.ts` returns `intervalEnding`, no bucketing.
- `components/offloading-tab.tsx` has 11 table columns, no `EditableCell`, no override map, no `Less gas` legend text.
- `npx tsx scripts/verify-offloading-math.ts` passes all checks.
- `npx tsc --noEmit` clean.
- `npm run lint` clean.
- Manual UI: 48 rows for 4-hr event, AEMO actuals populate, dynamic target visibly responds to over/under-delivery.
