"use client";

import React, { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Info, Copy, Check } from "lucide-react";
import {
  computeRows, snapToInterval, totalCap, reductionMW,
  type PDByInterval, type OffloadConfig,
} from "@/lib/offloading/math";

const STORAGE_KEY = "nem-offloading-config";

const INPUT_CLS =
  "bg-zinc-950 border border-zinc-700 rounded h-8 px-2 text-zinc-200 font-mono text-xs w-full outline-none focus:border-zinc-500";

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

function fmtMW(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
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
  intervals: Array<{
    intervalEnding: string;
    scadaLyb1: number | null;
    scadaLyb2: number | null;
    pdLyb1: number | null;
    pdLyb2: number | null;
  }>;
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

  const pdByInterval: PDByInterval = useMemo(() => {
    const map = new Map<string, { lyb1: number | null; lyb2: number | null }>();
    if (!data) return map;
    for (const iv of data.intervals) {
      map.set(iv.intervalEnding, { lyb1: iv.pdLyb1, lyb2: iv.pdLyb2 });
    }
    return map;
  }, [data]);

  const rows = useMemo(
    () => computeRows(config, pdByInterval),
    [config, pdByInterval],
  );

  const update = <K extends keyof OffloadConfig>(key: K, value: OffloadConfig[K]) =>
    setConfig((prev) => ({ ...prev, [key]: value }));

  const summaryText = useMemo(() => {
    const startLabel = fmtTimeOnly(config.startISO);
    const endISO = new Date(new Date(config.startISO).getTime() + config.durationHrs * 3600_000).toISOString();
    const endLabel = fmtTimeOnly(endISO);
    return `Coal offloading event — LYB reducing ${config.mwReduction.toFixed(0)} MWh from ${startLabel} to ${endLabel}.`;
  }, [config]);

  const copyColumn = (values: Array<number | null>) => {
    const text = values.map((v) => (v == null ? "" : v.toFixed(1))).join("\n");
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-4">
      <SummaryCard text={summaryText} />

      <Card className="bg-zinc-900/60 border-white/5">
        <CardContent className="p-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-8 gap-2 text-xs">
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
            <Field label="Duration (hrs)" tooltip="Total event duration in hours.">
              <NumInput className={SRC.INPUT} value={config.durationHrs} onChange={(v) => update("durationHrs", v)} min={1} max={99} maxDigits={2} />
            </Field>
            <Field label="Total MWh reduction" tooltip="Total MWh to offload across the whole event.">
              <NumInput className={SRC.INPUT} value={config.mwReduction} onChange={(v) => update("mwReduction", v)} min={0} />
            </Field>
            <Field label="LYB1 cap (MW)">
              <NumInput className={SRC.INPUT} value={config.lyb1Cap} onChange={(v) => update("lyb1Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field label="LYB2 cap (MW)">
              <NumInput className={SRC.INPUT} value={config.lyb2Cap} onChange={(v) => update("lyb2Cap", v)} min={0} max={999} maxDigits={3} />
            </Field>
            <Field label="LYB1 ramp (MW/min)" tooltip="LYB1 ramp rate of change.">
              <NumInput className={SRC.INPUT} value={config.lyb1RampRate} onChange={(v) => update("lyb1RampRate", v)} min={0} max={99} maxDigits={2} />
            </Field>
            <Field label="LYB2 ramp (MW/min)" tooltip="LYB2 ramp rate of change.">
              <NumInput className={SRC.INPUT} value={config.lyb2RampRate} onChange={(v) => update("lyb2RampRate", v)} min={0} max={99} maxDigits={2} />
            </Field>
          </div>
          <div className="text-[11px] text-zinc-400 flex gap-6">
            <span>Reduction rate: <span className="text-zinc-200 font-mono">{reductionMW(config).toFixed(1)} MW</span></span>
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
                  <TableHead className={`whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Interval ending<br/><span className="text-[9px] font-normal text-zinc-500">Market Time</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.AEMO}`}>
                    PD Gen<br/><span className="text-[9px] font-normal text-zinc-500">MW (sum)</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Reduction<br/><span className="text-[9px] font-normal text-zinc-500">MW / 5 min</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Forecast gen<br/><span className="text-[9px] font-normal text-zinc-500">MW (cap − red.)</span>
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.BID}`}>
                    <CopyableHeader label="LYB1 Bid" subtitle="MW" onCopy={() => copyColumn(rows.map((r) => r.lyb1BidMW))} />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.BID}`}>
                    <CopyableHeader label="LYB2 Bid" subtitle="MW" onCopy={() => copyColumn(rows.map((r) => r.lyb2BidMW))} />
                  </TableHead>
                  <TableHead className={`text-right whitespace-nowrap ${HEADER_SRC.CALC}`}>
                    Cum delivered<br/><span className="text-[9px] font-normal text-zinc-500">MWh</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.intervalEnding} className="border-white/5 font-mono text-xs">
                    <TableCell className={`whitespace-nowrap ${SRC.CALC}`}>{fmtIntervalLabel(r.intervalEnding)}</TableCell>
                    <TableCell className={`text-right ${SRC.AEMO}`}>{fmtMW(r.pdTotal)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.reductionMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.forecastGenTotal)}</TableCell>
                    <TableCell className={`text-right ${SRC.BID}`}>{fmtMW(r.lyb1BidMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.BID}`}>{fmtMW(r.lyb2BidMW)}</TableCell>
                    <TableCell className={`text-right ${SRC.CALC}`}>{fmtMW(r.cumReductionMWh)}</TableCell>
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
            ? "bg-emerald-500/20 text-emerald-300"
            : "bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300"
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

function Field({ label, children, className, tooltip }: {
  label: string; children: React.ReactNode; className?: string; tooltip?: string;
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
