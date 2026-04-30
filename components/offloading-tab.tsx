"use client";

import React, { useEffect, useMemo, useState, useCallback } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info, Copy, Check, RefreshCw } from "lucide-react";
import {
  computeRows, snapToInterval, totalCap, reductionMW,
  type ActualByInterval, type OffloadConfig,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";
const ACTUALS_KEY = "nem-offloading-actuals";

const INPUT_CLS =
  "bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded h-8 px-2 text-zinc-900 dark:text-zinc-200 font-mono text-xs w-full outline-none focus:border-zinc-400 dark:focus:border-zinc-500";

const SRC = {
  CALC:  "bg-orange-500/10",
  INPUT: "bg-yellow-400/30",
  AEMO:  "bg-blue-500/15",
  BID:   "bg-purple-500/15",
} as const;
const HEADER_SRC = {
  CALC:  "bg-orange-500/25",
  INPUT: "bg-yellow-400/50",
  AEMO:  "bg-blue-500/30",
  BID:   "bg-purple-500/30",
} as const;

const DEFAULTS: OffloadConfig = {
  startISO: snapToInterval(Date.now()),
  durationHrs: 4,
  mwReduction: 1600,
  lyb1Cap: 585,
  lyb2Cap: 585,
  lyb1RampRate: 10,
  lyb2RampRate: 10,
  lyb1PreOffload: 585,
  lyb2PreOffload: 585,
  bufferMW: 0,
};

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
    merged.startISO = snapToInterval(merged.startISO);
    return merged;
  } catch { return DEFAULTS; }
}

function saveConfig(cfg: OffloadConfig) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

type ActualsStore = Record<string, { lyb1: number | null; lyb2: number | null }>;

function loadActuals(): ActualsStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(ACTUALS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveActuals(a: ActualsStore) {
  try { localStorage.setItem(ACTUALS_KEY, JSON.stringify(a)); } catch { /* noop */ }
}

function fmtMW(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

function fmtBid(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return String(Math.round(v));
}

// Treat the ISO string literally (AEST wall-clock-as-Z) — slice rather than
// going through Date so we don't pick up a local-timezone offset.
function fmtIntervalLabel(iso: string): string {
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const dd = iso.slice(8, 10);
  const hhmm = iso.slice(11, 16);
  return `${dd}/${mm}/${yyyy.slice(2)} ${hhmm}`;
}

function fmtTimeOnly(iso: string): string {
  return iso.slice(11, 16);
}

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
});

interface APIResponse {
  intervals: Array<{
    intervalEnding: string;
    scadaLyb1: number | null;
    scadaLyb2: number | null;
  }>;
}

export function OffloadingTab() {
  const [config, setConfig] = useState<OffloadConfig>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [actuals, setActuals] = useState<ActualsStore>({});
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    const loaded = loadConfig();
    loaded.startISO = withDate(loaded.startISO, todayDateStr());
    setConfig(loaded);
    setActuals(loadActuals());
    setHydrated(true);
  }, []);
  useEffect(() => { if (hydrated) saveConfig(config); }, [config, hydrated]);
  useEffect(() => { if (hydrated) saveActuals(actuals); }, [actuals, hydrated]);

  const apiUrl = useMemo(() => {
    if (!hydrated) return null;
    const p = new URLSearchParams({ start: config.startISO, durationHrs: String(config.durationHrs) });
    return `/api/offloading?${p}`;
  }, [config.startISO, config.durationHrs, hydrated]);

  const { data, mutate } = useSWR<APIResponse>(apiUrl, fetcher, { refreshInterval: 30_000 });

  const actualByInterval: ActualByInterval = useMemo(() => {
    const map = new Map<string, { lyb1: number | null; lyb2: number | null }>();
    for (const [iv, v] of Object.entries(actuals)) map.set(iv, v);
    return map;
  }, [actuals]);

  const rows = useMemo(
    () => computeRows(config, actualByInterval),
    [config, actualByInterval],
  );

  const update = <K extends keyof OffloadConfig>(key: K, value: OffloadConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const setActual = (iv: string, lyb1: number | null, lyb2: number | null) => {
    setActuals((prev) => ({ ...prev, [iv]: { lyb1, lyb2 } }));
  };

  const clearActual = (iv: string) => {
    setActuals((prev) => {
      const next = { ...prev };
      delete next[iv];
      return next;
    });
  };

  const pullActuals = useCallback(async () => {
    if (!data) return;
    setPulling(true);
    try {
      // Re-fetch the API to get the latest SCADA values and overwrite any
      // existing actuals (manual or auto) with fresh SCADA where available.
      const fresh = (await mutate(undefined, { revalidate: true })) as APIResponse | undefined;
      const source = fresh ?? data;
      setActuals((prev) => {
        const next = { ...prev };
        for (const iv of source.intervals) {
          if (iv.scadaLyb1 == null && iv.scadaLyb2 == null) continue;
          next[iv.intervalEnding] = { lyb1: iv.scadaLyb1, lyb2: iv.scadaLyb2 };
        }
        return next;
      });
    } finally {
      setPulling(false);
    }
  }, [data, mutate]);

  const summaryText = useMemo(() => {
    const startLabel = fmtTimeOnly(config.startISO);
    const endISO = new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString();
    const endLabel = fmtTimeOnly(endISO);
    return `Coal offloading event — LYB reducing ${config.mwReduction.toFixed(0)} MWh from ${startLabel} to ${endLabel}.`;
  }, [config]);

  const copyColumn = (values: Array<number | null>) => {
    const text = values.map((v) => (v == null ? "" : String(Math.round(v)))).join("\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-4">
      <SummaryCard text={summaryText} />

      <Card className="bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-white/5">
        <CardContent className="p-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-11 gap-2 text-xs">
            <Field label="Start date">
              <input
                type="date"
                value={toDateInput(config.startISO)}
                onChange={(e) => update("startISO", withDate(config.startISO, e.target.value))}
                onClick={(e) => {
                  const el = e.currentTarget;
                  if (typeof el.showPicker === "function") el.showPicker();
                }}
                className={`${INPUT_CLS} ${SRC.INPUT} [color-scheme:light] dark:[color-scheme:dark] cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100`}
              />
            </Field>
            <Field label="Start time">
              <TimePicker
                value={toTimeInput(config.startISO)}
                onChange={(hhmm24) => update("startISO", withTime(config.startISO, hhmm24))}
              />
            </Field>
            <Field label="Duration (hrs)" tooltip="Total event duration in hours.">
              <NumInput className={SRC.INPUT} value={config.durationHrs} onChange={(v) => update("durationHrs", v)} min={1} max={99} maxDigits={2} />
            </Field>
            <Field label="MWh reduction" tooltip="Total MWh to offload across the whole event.">
              <NumInput className={SRC.INPUT} value={config.mwReduction} onChange={(v) => update("mwReduction", v)} min={0} />
            </Field>
            <Field
              label="LYB1 cap (MW)"
              tooltip="LYB1 registered capacity. Quarterly value provided by site."
            >
              <NumInput className={SRC.INPUT} value={config.lyb1Cap} onChange={(v) => update("lyb1Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field
              label="LYB2 cap (MW)"
              tooltip="LYB2 registered capacity. Quarterly value provided by site."
            >
              <NumInput className={SRC.INPUT} value={config.lyb2Cap} onChange={(v) => update("lyb2Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field label="LYB1 ramp (MW/m)" tooltip="LYB1 ramp rate of change.">
              <NumInput className={SRC.INPUT} value={config.lyb1RampRate} onChange={(v) => update("lyb1RampRate", v)} min={0} max={99} maxDigits={2} />
            </Field>
            <Field label="LYB2 ramp (MW/m)" tooltip="LYB2 ramp rate of change.">
              <NumInput className={SRC.INPUT} value={config.lyb2RampRate} onChange={(v) => update("lyb2RampRate", v)} min={0} max={99} maxDigits={2} />
            </Field>
            <Field
              label="LYB1 pre-offload (MW)"
              tooltip="MW LYB1 will be running at the interval immediately before the offload begins. Used as the ramp-down anchor for the first bid. Bids ramp from this value toward the offload setpoint at the LYB1 ramp rate."
            >
              <NumInput className={SRC.INPUT} value={config.lyb1PreOffload} onChange={(v) => update("lyb1PreOffload", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field
              label="LYB2 pre-offload (MW)"
              tooltip="MW LYB2 will be running at the interval immediately before the offload begins. Used as the ramp-down anchor for the first bid. Bids ramp from this value toward the offload setpoint at the LYB2 ramp rate."
            >
              <NumInput className={SRC.INPUT} value={config.lyb2PreOffload} onChange={(v) => update("lyb2PreOffload", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field
              label="Buffer (MWh)"
              tooltip="Extra MWh of reduction to deliver above the target. e.g. 10 MWh buffer + 1600 MWh reduction = solver aims for 1610 MWh total, so cum-delivered settles ~10 MWh above target as a safety margin."
            >
              <NumInput className={SRC.INPUT} value={config.bufferMW} onChange={(v) => update("bufferMW", v)} min={0} max={999} maxDigits={3} />
            </Field>
          </div>
          <div className="text-[11px] text-zinc-600 dark:text-zinc-400 flex gap-6">
            <span>Reduction rate: <span className="text-zinc-900 dark:text-zinc-200 font-mono">{reductionMW(config).toFixed(1)} MW</span></span>
            <span>Total capacity: <span className="text-zinc-900 dark:text-zinc-200 font-mono">{totalCap(config)} MW</span></span>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-white/5">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-200 dark:border-white/5">
                  <TableHead className={`whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Interval ending<br/><span className="text-[9px] font-normal text-zinc-500 dark:text-zinc-500">Market Time</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.AEMO}`}>
                    <ActualGenHeader onPull={pullActuals} pulling={pulling} />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.AEMO}`}>
                    <DeltaHeader />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Reduction<br/><span className="text-[9px] font-normal text-zinc-500">MW / 5 min</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Forecast gen<br/><span className="text-[9px] font-normal text-zinc-500">MW</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.BID}`}>
                    <CopyableHeader label="LYB1 Bid" subtitle="MW (target)" onCopy={() => copyColumn(rows.map((r) => r.lyb1BidMW))} />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.BID}`}>
                    <CopyableHeader label="LYB2 Bid" subtitle="MW (target)" onCopy={() => copyColumn(rows.map((r) => r.lyb2BidMW))} />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    MWh offloaded<br/><span className="text-[9px] font-normal text-zinc-500">cumulative vs target</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.intervalEnding} className="border-zinc-200 dark:border-white/5 font-mono text-xs">
                    <TableCell className={`whitespace-nowrap ${SRC.CALC}`}>{fmtIntervalLabel(r.intervalEnding)}</TableCell>
                    <TableCell className={`text-right p-0 ${SRC.AEMO}`}>
                      <ActualGenCell
                        sum={r.actualGenStart}
                        onCommit={(sum) => {
                          if (sum == null) clearActual(r.intervalEnding);
                          else setActual(r.intervalEnding, sum / 2, sum / 2);
                        }}
                      />
                    </TableCell>
                    <TableCell className={`text-right ${SRC.AEMO}`}>
                      <DeltaCell deltaMW={r.deltaMW} />
                    </TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtBid(r.reductionMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtBid(r.forecastGenTotal)}</TableCell>
                    <TableCell className={`text-right ${SRC.BID}`}>{fmtBid(r.lyb1BidMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.BID}`}>{fmtBid(r.lyb2BidMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtBid(r.cumReductionMWh)}</TableCell>
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

function DeltaHeader() {
  return (
    <span className="inline-flex flex-col items-end">
      <span className="inline-flex items-center gap-1">
        Δ vs target
        <span
          title="Avg actual gen this interval minus the forecast target. Positive means the units stayed above target so upcoming bids drop further to make up the shortfall. Negative means we over-reduced and upcoming bids relax."
          className="cursor-help text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <Info className="h-3 w-3" />
        </span>
      </span>
      <span className="text-[9px] font-normal text-zinc-500">MW</span>
    </span>
  );
}

function DeltaCell({ deltaMW }: { deltaMW: number | null }) {
  if (deltaMW == null) return <span className="text-zinc-400 dark:text-zinc-600">—</span>;
  const sign = deltaMW > 0.05 ? "+" : "";
  const cls =
    Math.abs(deltaMW) < 0.05
      ? "text-zinc-500"
      : deltaMW > 0
        ? "text-amber-700 dark:text-amber-400"
        : "text-emerald-700 dark:text-emerald-400";
  return <span className={cls}>{sign}{deltaMW.toFixed(1)}</span>;
}

function ActualGenHeader({ onPull, pulling }: { onPull: () => void; pulling: boolean }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="flex flex-col items-end">
        <span className="inline-flex items-center gap-1">
          Actual gen
          <span
            title="Actual MW at start of interval. Refresh to back-fill from SCADA, or edit manually."
            className="cursor-help text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <Info className="h-3 w-3" />
          </span>
        </span>
        <span className="text-[9px] font-normal text-zinc-500">MW (sum, start)</span>
      </span>
      <button
        onClick={onPull}
        disabled={pulling}
        title="Pull actual SCADA data for past intervals"
        className={`shrink-0 inline-flex items-center justify-center h-5 w-5 rounded transition-colors ${
          pulling
            ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400"
            : "bg-zinc-200 dark:bg-zinc-800/80 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300"
        }`}
      >
        <RefreshCw className={`h-3 w-3 ${pulling ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}

function ActualGenCell({ sum, onCommit }: { sum: number | null; onCommit: (sum: number | null) => void }) {
  const display = sum == null ? "" : String(Math.round(sum));
  const [local, setLocal] = useState<string>(display);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setLocal(display);
  }, [display, editing]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={local}
      placeholder="—"
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
        setLocal(raw);
      }}
      onBlur={() => {
        setEditing(false);
        if (local === "") {
          if (sum != null) onCommit(null);
          return;
        }
        const n = Number(local);
        if (!Number.isFinite(n)) {
          setLocal(display);
          return;
        }
        if (sum == null || Math.abs(n - sum) > 0.001) onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setLocal(display);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className="bg-transparent w-full h-7 px-2 text-right text-zinc-900 dark:text-zinc-200 font-mono text-xs outline-none focus:bg-white/60 dark:focus:bg-zinc-950/50 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
    />
  );
}

function CopyableHeader({ label, subtitle, onCopy }: { label: string; subtitle: string; onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  const handle = () => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="flex flex-col items-end">
        <span>{label}</span>
        <span className="text-[9px] font-normal text-zinc-500">{subtitle}</span>
      </span>
      <button
        onClick={handle}
        title={`Copy column "${label}" (newline-separated)`}
        className={`shrink-0 inline-flex items-center justify-center h-5 w-5 rounded transition-colors ${
          copied
            ? "bg-emerald-200 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            : "bg-zinc-200 dark:bg-zinc-800/80 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300"
        }`}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
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
    <Card className="bg-white dark:bg-zinc-900/60 border-zinc-200 dark:border-white/5 py-0 gap-0">
      <CardContent className="px-3 py-2 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-600 dark:text-zinc-500 whitespace-nowrap">P bid reason</span>
        <div className="flex-1 text-xs font-mono text-zinc-900 dark:text-zinc-200 select-all truncate">{text}</div>
        <button
          onClick={copy}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
            copied
              ? "bg-emerald-100 dark:bg-emerald-500/15 border border-emerald-400 dark:border-emerald-500/40 text-emerald-800 dark:text-emerald-300"
              : "bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700"
          }`}
          title="Copy to clipboard"
        >
          {copied ? (<><Check className="h-3 w-3" /> Copied</>) : (<><Copy className="h-3 w-3" /> Copy</>)}
        </button>
      </CardContent>
    </Card>
  );
}

function Field({ label, children, className, tooltip }: {
  label: string; children: React.ReactNode; className?: string; tooltip?: string;
}) {
  return (
    <label className={`flex flex-col gap-1${className ? ` ${className}` : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-zinc-700 dark:text-zinc-300 flex items-center gap-1">
        {label}
        {tooltip && (
          <span title={tooltip} className="cursor-help text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300">
            <Info className="h-3 w-3" />
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

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

  const triggerCls = `bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded h-8 px-1 text-zinc-900 dark:text-zinc-200 font-mono text-xs min-w-0 w-full ${SRC.INPUT}`;

  return (
    <div className="flex gap-0.5 items-center min-w-0">
      <Select value={String(h12)} onValueChange={(v) => commit(Number(v), m, ampm)}>
        <SelectTrigger size="sm" className={triggerCls}><SelectValue>{pad2(h12)}</SelectValue></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
            <SelectItem key={h} value={String(h)}>{pad2(h)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
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

function NumInput({ value, onChange, min, max, maxDigits, className }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; maxDigits?: number; className?: string;
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

  const handleBlur = () => { if (local === "") setLocal(String(value)); };

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

// All timestamps in this module are treated as "AEST wall-clock as ISO-Z string".
// AEMO archives stamp SETTLEMENTDATE in AEST without a timezone marker, and the
// shared aemoToIso helper just appends "Z" — so a 14:00 AEST reading lands as
// "...T14:00:00.000Z". For the SCADA back-fill to match, our request strings
// must use the same convention (i.e. NEVER apply a real local→UTC offset).

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toDateInput(iso: string): string {
  return iso.slice(0, 10);
}

function toTimeInput(iso: string): string {
  return iso.slice(11, 16);
}

function withDate(iso: string, dateStr: string): string {
  return `${dateStr}T${toTimeInput(iso)}:00.000Z`;
}

function withTime(iso: string, timeStr: string): string {
  return `${toDateInput(iso)}T${timeStr}:00.000Z`;
}
