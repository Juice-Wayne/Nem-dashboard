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
