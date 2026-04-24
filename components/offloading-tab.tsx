"use client";

import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info, Copy, Check } from "lucide-react";
import {
  applyActuals, buildSchedule, offloadRate, totalCap, progressState,
  type OffloadConfig, type ActualsByHH, type OverridesByHH, type RowOverrides,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";

/** Shared input styling so Date / Time / Number inputs line up visually. */
const INPUT_CLS =
  "bg-zinc-950 border border-zinc-700 rounded h-8 px-2 text-zinc-200 font-mono text-xs w-full outline-none focus:border-zinc-500";

/** Data provenance color coding. Tint backgrounds let you see at a glance where each
 *  number came from: calculated from inputs (orange), manual input (yellow), or AEMO (blue). */
const SRC = {
  CALC:  "bg-orange-500/10",
  INPUT: "bg-yellow-400/30",   // highlighter-yellow so editable cells are obvious
  AEMO:  "bg-blue-500/15",
} as const;
const HEADER_SRC = {
  CALC:  "bg-orange-500/25",
  INPUT: "bg-yellow-400/50",
  AEMO:  "bg-blue-500/30",
} as const;

const DEFAULTS: OffloadConfig = {
  startISO: nextHalfHourISO(),
  durationHrs: 4,
  mwReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
};

// Editable per-row fields users can override or paste-fill.
type OverrideField = "lyb1Actual" | "lyb2Actual" | "lyb1Gas" | "lyb2Gas";
const OVERRIDE_FIELDS: OverrideField[] = ["lyb1Actual", "lyb1Gas", "lyb2Actual", "lyb2Gas"];

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

function fmtSignedMWh(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function fmtHHLabel(iso: string): string {
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
  intervals: Array<{ hhEnding: string; lyb1Mw: number | null; lyb2Mw: number | null }>;
}

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

  const actuals: ActualsByHH = useMemo(() => {
    const map = new Map<string, { lyb1: number; lyb2: number }>();
    if (!data) return map;
    for (const iv of data.intervals) {
      if (iv.lyb1Mw != null && iv.lyb2Mw != null) {
        map.set(iv.hhEnding, { lyb1: iv.lyb1Mw, lyb2: iv.lyb2Mw });
      }
    }
    return map;
  }, [data]);

  const [overridesMap, setOverridesMap] = useState<OverridesByHH>(() => new Map());

  const setOverride = (hhEnding: string, field: OverrideField, value: number | undefined) => {
    setOverridesMap((prev) => {
      const next = new Map(prev);
      const row: RowOverrides = { ...(next.get(hhEnding) ?? {}) };
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

  const handlePaste = (rowIdx: number, field: OverrideField, text: string) => {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length);
    const startColIdx = OVERRIDE_FIELDS.indexOf(field);
    setOverridesMap((prev) => {
      const next = new Map(prev);
      lines.forEach((line, lineIdx) => {
        const cells = line.split("\t");
        cells.forEach((raw, colIdx) => {
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          const targetRowIdx = rowIdx + lineIdx;
          const targetField = OVERRIDE_FIELDS[startColIdx + colIdx];
          const targetRow = rows[targetRowIdx];
          if (!targetRow || !targetField) return;
          const existing: RowOverrides = { ...(next.get(targetRow.hhEnding) ?? {}) };
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

  // Summary text shown at top + copied to clipboard.
  const summaryText = useMemo(() => {
    const startLabel = fmtTimeOnly(config.startISO);
    const endISO = new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString();
    const endLabel = fmtTimeOnly(endISO);
    const forecastMW = rows[0]?.forecastMW ?? 0;
    return `Coal offloading event — LYB reducing to ~${forecastMW.toFixed(0)} MW from HH ${startLabel} to ${endLabel}. Target ${config.mwReduction.toFixed(0)} MWh reduction.`;
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
            <span>Offload rate: <span className="text-zinc-200 font-mono">{offloadRate(config).toFixed(1)} MW/hh</span></span>
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
                  <TableHead className={`whitespace-nowrap ${HEADER_SRC.CALC}`}>HH ending<br/><span className="text-[9px] font-normal text-zinc-500">Market Time</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Target MW<br/><span className="text-[9px] font-normal text-zinc-500">/ hh</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Target<br/><span className="text-[9px] font-normal text-zinc-500">Offload MWh</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Forecast<br/><span className="text-[9px] font-normal text-zinc-500">MW</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Actual<br/><span className="text-[9px] font-normal text-zinc-500">MW</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>MW Loss</TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Act Offload<br/><span className="text-[9px] font-normal text-zinc-500">MWh</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Cum MWh<br/><span className="text-[9px] font-normal text-zinc-500">Loss</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap border-l border-white/10 ${HEADER_SRC.CALC}`}>LYB1<br/><span className="text-[9px] font-normal text-zinc-500">Bid target</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>LYB2<br/><span className="text-[9px] font-normal text-zinc-500">Bid target</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Total<br/><span className="text-[9px] font-normal text-zinc-500">bid</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap border-l border-white/10 ${HEADER_SRC.AEMO}`}>LYB1<br/><span className="text-[9px] font-normal text-zinc-500">actual</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.INPUT}`}>Less gas<br/><span className="text-[9px] font-normal text-zinc-500">LYB1</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.AEMO}`}>LYB2<br/><span className="text-[9px] font-normal text-zinc-500">actual</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.INPUT}`}>Less gas<br/><span className="text-[9px] font-normal text-zinc-500">LYB2</span></TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>Total<br/><span className="text-[9px] font-normal text-zinc-500">actual</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, rowIdx) => {
                  const bidTotal = r.lyb1TargetMW + r.lyb2TargetMW;
                  // Display fallback: when no unit actual yet, show forecast split so the row reads sensibly.
                  const lyb1Display = r.lyb1Actual ?? r.lyb1TargetMW;
                  const lyb2Display = r.lyb2Actual ?? r.lyb2TargetMW;
                  return (
                    <TableRow key={r.hhEnding} className="border-white/5 font-mono text-xs">
                      <TableCell className={`whitespace-nowrap ${SRC.CALC}`}>{fmtHHLabel(r.hhEnding)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.targetOffloadMW)}</TableCell>
                      <TableCell className={`text-right text-zinc-400 ${SRC.CALC}`}>{fmtSignedMWh(r.targetCumMWh)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.forecastMW)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC} ${r.totalActualMW == null ? "italic text-zinc-500" : ""}`}>
                        {fmtMW(r.totalActualMW ?? r.forecastMW)}
                      </TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.mwLoss)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.mwhThisHH)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.cumMWh)}</TableCell>
                      <TableCell className={`text-right border-l border-white/10 ${SRC.CALC}`}>{fmtMW(r.lyb1TargetMW)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.lyb2TargetMW)}</TableCell>
                      <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(bidTotal)}</TableCell>
                      <EditableCell
                        className={`border-l border-white/10 ${r.overridden.lyb1Actual ? SRC.INPUT : SRC.AEMO}`}
                        value={lyb1Display}
                        isOverride={r.overridden.lyb1Actual}
                        isFallback={r.lyb1Actual == null}
                        onCommit={(v) => setOverride(r.hhEnding, "lyb1Actual", v)}
                        onRevert={() => setOverride(r.hhEnding, "lyb1Actual", undefined)}
                        onPaste={(text) => handlePaste(rowIdx, "lyb1Actual", text)}
                      />
                      <EditableCell
                        className={SRC.INPUT}
                        value={r.lyb1Gas}
                        isOverride={r.overridden.lyb1Gas}
                        onCommit={(v) => setOverride(r.hhEnding, "lyb1Gas", v)}
                        onRevert={() => setOverride(r.hhEnding, "lyb1Gas", undefined)}
                        onPaste={(text) => handlePaste(rowIdx, "lyb1Gas", text)}
                      />
                      <EditableCell
                        className={r.overridden.lyb2Actual ? SRC.INPUT : SRC.AEMO}
                        value={lyb2Display}
                        isOverride={r.overridden.lyb2Actual}
                        isFallback={r.lyb2Actual == null}
                        onCommit={(v) => setOverride(r.hhEnding, "lyb2Actual", v)}
                        onRevert={() => setOverride(r.hhEnding, "lyb2Actual", undefined)}
                        onPaste={(text) => handlePaste(rowIdx, "lyb2Actual", text)}
                      />
                      <EditableCell
                        className={SRC.INPUT}
                        value={r.lyb2Gas}
                        isOverride={r.overridden.lyb2Gas}
                        onCommit={(v) => setOverride(r.hhEnding, "lyb2Gas", v)}
                        onRevert={() => setOverride(r.hhEnding, "lyb2Gas", undefined)}
                        onPaste={(text) => handlePaste(rowIdx, "lyb2Gas", text)}
                      />
                      <TableCell className={`text-right font-medium ${SRC.CALC} ${r.totalActualMW == null ? "italic text-zinc-500" : "text-zinc-100"}`}>
                        {fmtMW(r.totalActualMW ?? r.forecastMW)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
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
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DebugLegend() {
  const Row = ({ bg, label, example }: { bg: string; label: string; example: string }) => (
    <div className="flex items-center gap-2">
      <span className={`${bg} h-4 w-4 rounded border border-white/10 shrink-0`} />
      <span className="text-zinc-200 font-medium whitespace-nowrap">{label}</span>
      <span className="text-zinc-500 text-[10px]">{example}</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1 px-1 text-[11px]">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">Key</span>
      <div className="relative group">
        <Info className="h-3 w-3 text-zinc-600 hover:text-zinc-400 cursor-help" />
        <div className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-5 top-1/2 -translate-y-1/2 z-20 bg-zinc-900 border border-zinc-700 rounded-md p-3 shadow-xl w-max">
          <div className="flex flex-col gap-2 text-xs">
            <Row bg={SRC.INPUT} label="Manual input" example="e.g. Duration, Total MW reduction, LYB capacities, Less gas" />
            <Row bg={SRC.AEMO} label="From AEMO" example="Actuals pulled from DISPATCHSCADA (LOYYB1, LOYYB2)" />
            <Row bg={SRC.CALC} label="Calculated" example="Forecast, MW Loss, Cum MWh, Bid targets (derived from inputs)" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Card className="bg-zinc-900/60 border-white/5 py-0 gap-0">
      <CardContent className="px-3 py-2 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 whitespace-nowrap">P bid reason</span>
        <div className="flex-1 text-xs font-mono text-zinc-200 select-all truncate">{text}</div>
        <button
          onClick={copy}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
            copied
              ? "bg-emerald-500/15 border border-emerald-500/40 text-emerald-300"
              : "bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700"
          }`}
          title="Copy to clipboard"
        >
          {copied ? (<><Check className="h-3 w-3" /> Copied</>) : (<><Copy className="h-3 w-3" /> Copy</>)}
        </button>
      </CardContent>
    </Card>
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

  const triggerCls = `bg-zinc-950 border border-zinc-700 rounded h-8 px-2 text-zinc-200 font-mono text-xs min-w-0 w-full ${SRC.INPUT}`;

  return (
    <div className="flex gap-1 items-center">
      <Select value={String(h12)} onValueChange={(v) => commit(Number(v), m, ampm)}>
        <SelectTrigger size="sm" className={triggerCls}><SelectValue>{pad2(h12)}</SelectValue></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <SelectItem key={h} value={String(h)}>{pad2(h)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-zinc-500">:</span>
      <Select value={String(m)} onValueChange={(v) => commit(h12, Number(v), ampm)}>
        <SelectTrigger size="sm" className={triggerCls}><SelectValue>{pad2(m)}</SelectValue></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i * 5).map((mm) => (
            <SelectItem key={mm} value={String(mm)}>{pad2(mm)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={ampm} onValueChange={(v) => commit(h12, m, v as "AM" | "PM")}>
        <SelectTrigger size="sm" className={triggerCls}><SelectValue>{ampm}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="AM">AM</SelectItem>
          <SelectItem value="PM">PM</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function NumInput({
  value, onChange, min, max, maxDigits, className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  maxDigits?: number;
  className?: string;
}) {
  const [local, setLocal] = useState<string>(String(value));

  useEffect(() => {
    if (local === "" || Number(local) !== value) setLocal(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
    if (maxDigits && raw.replace(/\D/g, "").length > maxDigits) return;
    setLocal(raw);
    if (raw === "") return;
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
      className={`${INPUT_CLS}${className ? ` ${className}` : ""}`}
    />
  );
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function withDate(iso: string, dateStr: string): string {
  return new Date(`${dateStr}T${toTimeInput(iso)}`).toISOString();
}

function withTime(iso: string, timeStr: string): string {
  return new Date(`${toDateInput(iso)}T${timeStr}`).toISOString();
}

function EditableCell({
  value, isOverride, isFallback = false, className, onCommit, onRevert, onPaste,
}: {
  value: number | null;
  isOverride: boolean;
  isFallback?: boolean;
  className?: string;
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
      className={`text-right relative cursor-text ${isOverride ? "border-l-2 border-l-blue-500" : ""} ${className ?? ""}`}
      onClick={(e) => { if (!editing) { e.stopPropagation(); startEdit(); } }}
    >
      {editing ? (
        <input
          autoFocus
          size={1}
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
          className="w-full min-w-0 bg-zinc-950 border border-blue-500 rounded px-1 py-0 text-right font-mono text-xs text-zinc-100 outline-none"
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
