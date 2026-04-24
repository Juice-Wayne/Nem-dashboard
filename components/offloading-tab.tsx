"use client";

import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info } from "lucide-react";
import {
  applyActuals, buildSchedule, offloadRate, totalCap, progressState,
  type OffloadConfig, type ActualsByHH, type OverridesByHH,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";

const DEFAULTS: OffloadConfig = {
  startISO: nextHalfHourISO(),
  durationHrs: 4,
  mwReduction: 1600,
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
    const parsed = JSON.parse(raw) as Partial<OffloadConfig> & { mwhReduction?: number };
    // Migrate legacy `mwhReduction` → `mwReduction` (same semantics: total reduction across event).
    if (parsed.mwReduction == null && parsed.mwhReduction != null) {
      parsed.mwReduction = parsed.mwhReduction;
      delete parsed.mwhReduction;
    }
    return { ...DEFAULTS, ...parsed } as OffloadConfig;
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

  // On mount: hydrate from localStorage but always reset the DATE portion of startISO
  // to today. Events are almost always same-day; a user who wants a historical date
  // can still change it — that change just won't persist to the next session.
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

  const [overridesMap, setOverridesMap] = useState<OverridesByHH>(() => new Map());

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

  const rows = useMemo(
    () => applyActuals(schedule, actuals, overridesMap, config),
    [schedule, actuals, overridesMap, config],
  );

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

  const cumTotal = rows[rows.length - 1]?.cumMWh ?? 0;
  const progress = progressState(rows, config);

  const update = <K extends keyof OffloadConfig>(key: K, value: OffloadConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs">
            <Field label="Start date">
              <input
                type="date"
                value={toDateInput(config.startISO)}
                onChange={(e) => update("startISO", withDate(config.startISO, e.target.value))}
                className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 font-mono w-full"
              />
            </Field>
            <Field label="Start time">
              <TimePicker
                value={toTimeInput(config.startISO)}
                onChange={(hhmm24) => update("startISO", withTime(config.startISO, hhmm24))}
              />
            </Field>
            <Field label="Duration (hrs)" tooltip="Input the total duration in hours of the offloading event.">
              <NumInput value={config.durationHrs} onChange={(v) => update("durationHrs", v)} min={1} max={99} maxDigits={2} />
            </Field>
            <Field label="Total MW reduction" tooltip="Input the total amount of MW needed to offload across the whole event.">
              <NumInput value={config.mwReduction} onChange={(v) => update("mwReduction", v)} min={0} />
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
              {rows.map((r, rowIdx) => (
                <TableRow key={r.hhEnding} className="border-white/5 font-mono text-xs">
                  <TableCell>{fmtHHLabel(r.hhEnding)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.targetOffloadMW)}</TableCell>
                  <EditableCell
                    value={r.lyb1TargetMW}
                    isOverride={r.overridden.lyb1TargetMW}
                    onCommit={(v) => setOverride(r.hhEnding, "lyb1TargetMW", v)}
                    onRevert={() => setOverride(r.hhEnding, "lyb1TargetMW", undefined)}
                    onPaste={(text) => handlePaste(rowIdx, "lyb1TargetMW", text)}
                  />
                  <EditableCell
                    value={r.lyb2TargetMW}
                    isOverride={r.overridden.lyb2TargetMW}
                    onCommit={(v) => setOverride(r.hhEnding, "lyb2TargetMW", v)}
                    onRevert={() => setOverride(r.hhEnding, "lyb2TargetMW", undefined)}
                    onPaste={(text) => handlePaste(rowIdx, "lyb2TargetMW", text)}
                  />
                  <TableCell className="text-right">{fmtMW(r.forecastMW)}</TableCell>
                  <EditableCell
                    value={r.actualMW ?? r.forecastMW}
                    isOverride={r.overridden.actualMW}
                    isFallback={r.actualMW == null}
                    onCommit={(v) => setOverride(r.hhEnding, "actualMW", v)}
                    onRevert={() => setOverride(r.hhEnding, "actualMW", undefined)}
                    onPaste={(text) => handlePaste(rowIdx, "actualMW", text)}
                  />
                  <TableCell className="text-right">{fmtMW(r.mwLoss)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.mwhThisHH)}</TableCell>
                  <TableCell className="text-right">{fmtMW(r.cumMWh)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 pt-3">
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${progress === "over" ? "bg-red-500" : progress === "behind" ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${Math.min((cumTotal / Math.max(config.mwReduction, 1)) * 100, 100).toFixed(1)}%` }}
              />
            </div>
          </div>
          <div className="p-3 text-xs flex items-center gap-3">
            <span className="text-zinc-400">Cumulative:</span>
            <span className="font-mono text-zinc-100">{cumTotal.toFixed(1)} / {config.mwReduction.toFixed(0)} MWh</span>
            <span className={`text-[11px] ${progress === "over" ? "text-red-400" : progress === "behind" ? "text-amber-400" : "text-emerald-400"}`}>
              {progress === "over" ? "over target" : progress === "behind" ? "behind schedule" : "on track"}
            </span>
            <button
              onClick={() => {
                const startLabel = fmtHHLabel(config.startISO);
                const endLabel = fmtHHLabel(new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString());
                const forecastMW = rows[0]?.forecastMW ?? 0;
                const text = `Coal offloading event — LYB reducing to ~${forecastMW.toFixed(0)} MW from HH ${startLabel} to ${endLabel}. Target ${config.mwReduction.toFixed(0)} MWh reduction.`;
                void navigator.clipboard.writeText(text);
              }}
              className="ml-auto px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-[11px]"
            >
              Copy summary
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label, children, className, tooltip,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  tooltip?: string;
}) {
  return (
    <label className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-zinc-500 flex items-center gap-1">
        {label}
        {tooltip && (
          <span title={tooltip} className="cursor-help text-zinc-600 hover:text-zinc-400">
            <Info className="h-3 w-3" />
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/** Three-select time picker: hour (1–12), minute (0/5/…/55), AM/PM. Value + onChange in "HH:MM" 24-hr. */
function TimePicker({ value, onChange }: { value: string; onChange: (hhmm24: string) => void }) {
  const [h24Str = "00", mStr = "00"] = value.split(":");
  const h24 = Number(h24Str);
  const m = Number(mStr);
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  const h12 = ((h24 + 11) % 12) + 1;

  const commit = (newH12: number, newM: number, newAmpm: "AM" | "PM") => {
    const newH24 = newAmpm === "PM" ? ((newH12 % 12) + 12) : (newH12 % 12);
    onChange(`${pad2(newH24)}:${pad2(newM)}`);
  };

  const triggerCls = "bg-zinc-950 border-zinc-700 text-zinc-200 font-mono h-8 px-2 min-w-0 w-14 text-xs";

  return (
    <div className="flex gap-1 items-center">
      <Select value={String(h12)} onValueChange={(v) => commit(Number(v), m, ampm)}>
        <SelectTrigger className={triggerCls}><SelectValue>{pad2(h12)}</SelectValue></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <SelectItem key={h} value={String(h)}>{pad2(h)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-zinc-500">:</span>
      <Select value={String(m)} onValueChange={(v) => commit(h12, Number(v), ampm)}>
        <SelectTrigger className={triggerCls}><SelectValue>{pad2(m)}</SelectValue></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i * 5).map((mm) => (
            <SelectItem key={mm} value={String(mm)}>{pad2(mm)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={ampm} onValueChange={(v) => commit(h12, m, v as "AM" | "PM")}>
        <SelectTrigger className={triggerCls}><SelectValue>{ampm}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="AM">AM</SelectItem>
          <SelectItem value="PM">PM</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function NumInput({
  value, onChange, min, max, maxDigits,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** Cap the number of digits a user can type. Useful for short fields (e.g. duration ≤ 99). */
  maxDigits?: number;
}) {
  // Local string lets the user blank the field while typing; parent only sees valid numbers.
  const [local, setLocal] = useState<string>(String(value));

  // Reflect external changes to `value` unless the user is mid-edit with an equivalent number.
  useEffect(() => {
    if (local === "" || Number(local) !== value) setLocal(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
    if (maxDigits && raw.replace(/\D/g, "").length > maxDigits) return;
    setLocal(raw);
    if (raw === "") return;  // blank display; don't commit a value
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(n);
  };

  const handleBlur = () => {
    if (local === "") setLocal(String(value));
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={local}
      onChange={handleChange}
      onBlur={handleBlur}
      min={min}
      max={max}
      className="bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-zinc-200 font-mono w-full"
    />
  );
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** Today's date in the user's local timezone, as "YYYY-MM-DD". */
function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO → "YYYY-MM-DD" (local date) for a date input. */
function toDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO → "HH:MM" (local time) for a time input. */
function toTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Replace the date portion of an ISO (keeping local time-of-day) and return a new UTC ISO. */
function withDate(iso: string, dateStr: string): string {
  return new Date(`${dateStr}T${toTimeInput(iso)}`).toISOString();
}

/** Replace the time portion of an ISO (keeping local date) and return a new UTC ISO. */
function withTime(iso: string, timeStr: string): string {
  return new Date(`${toDateInput(iso)}T${timeStr}`).toISOString();
}

function EditableCell({
  value, isOverride, isFallback = false, onCommit, onRevert, onPaste,
}: {
  value: number | null;
  isOverride: boolean;
  /** When true, the displayed value is a forecast stand-in (not a confirmed measurement).
   *  Renders italic/muted so the user can tell it's not real data yet and click to enter one. */
  isFallback?: boolean;
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
          <span
            className={isFallback ? "italic text-zinc-500" : undefined}
            title={isFallback ? "Forecast — click to enter actual" : undefined}
          >
            {display}
          </span>
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
