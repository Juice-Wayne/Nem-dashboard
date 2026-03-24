"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ArrowLeft, Search, Copy, Check, Sun, Moon } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  Area, ReferenceLine,
  ComposedChart,
} from "recharts";

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
};

function shortDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function shortTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-zinc-700/80 bg-zinc-900/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur-sm">
      <p className="text-zinc-500 mb-0.5">{label}</p>
      {payload.map((p: { name: string; value: number; color: string }, i: number) => (
        <p key={i} style={{ color: p.color }} className="leading-tight">
          {p.name}: <span className="font-mono font-semibold">{typeof p.value === "number" ? p.value.toFixed(1) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

// =======================================================================
// Rebid Tracker — Energy vs FCAS (grouped)
// =======================================================================

interface RebidRow {
  DUID: string;
  BIDCATEGORY: "ENERGY" | "FCAS";
  FCAS_SERVICES: string[];
  REBIDTIME: string;
  REBIDCATEGORY: string;
  REBIDEXPLANATION: string;
  BANDAVAIL: number[];
  PRICEBAND: number[];
  TOTALAVAIL: number;
}

function RebidsTab() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | "ENERGY" | "FCAS">("ENERGY");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const { data, error } = useSWR("/api/analytics?tab=rebids", fetcher, { refreshInterval: 15000 });

  const { filtered, counts } = useMemo(() => {
    if (!data?.rebids) return { filtered: [] as RebidRow[], counts: { total: 0, energy: 0, fcas: 0 } };
    const all = data.rebids as RebidRow[];
    const energy = all.filter((r) => r.BIDCATEGORY === "ENERGY").length;
    const fcas = all.filter((r) => r.BIDCATEGORY === "FCAS").length;

    let rows = all;
    if (categoryFilter !== "ALL") {
      rows = rows.filter((r) => r.BIDCATEGORY === categoryFilter);
    }
    if (search) {
      const s = search.toUpperCase();
      rows = rows.filter((r) => r.DUID.includes(s) || r.REBIDEXPLANATION.toUpperCase().includes(s));
    }
    return { filtered: rows.slice(0, 100), counts: { total: all.length, energy, fcas } };
  }, [data, search, categoryFilter]);

  const copyExplanation = useCallback((text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  }, []);

  if (error) return <p className="text-red-400 text-sm p-4">Failed to load</p>;
  if (!data) return <p className="text-zinc-500 text-sm p-4">Loading...</p>;

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
          <input
            type="text"
            placeholder="Search DUID or reason..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7 pr-3 py-1.5 text-[11px] rounded-md bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 w-52"
          />
        </div>
        <div className="flex items-center gap-1">
          {(["ALL", "ENERGY", "FCAS"] as const).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${categoryFilter === cat ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
            >
              {cat === "ALL" ? `All (${counts.total})` : cat === "ENERGY" ? `Energy (${counts.energy})` : `FCAS (${counts.fcas})`}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600 ml-auto">{filtered.length} shown</span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="text-zinc-500 text-sm p-4">No rebids found</p>
      ) : (
        <Card className="rounded-xl">
          <CardContent className="px-0 pb-0">
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-800/50">
                    <th className="text-left font-medium text-zinc-500 px-3 py-2 w-20">Time</th>
                    <th className="text-left font-medium text-zinc-500 px-3 py-2 w-24">DUID</th>
                    <th className="text-left font-medium text-zinc-500 px-3 py-2 w-16">Type</th>
                    <th className="text-right font-medium text-zinc-500 px-3 py-2 w-16">MW</th>
                    <th className="text-left font-medium text-zinc-500 px-3 py-2">Reason</th>
                    <th className="text-left font-medium text-zinc-500 px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr
                      key={`${r.DUID}-${r.REBIDTIME}-${r.BIDCATEGORY}-${i}`}
                      className="border-b border-zinc-800/30 hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-3 py-2 text-[10px] text-zinc-500 whitespace-nowrap align-top">
                        {shortDateTime(r.REBIDTIME)}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold text-zinc-200 whitespace-nowrap align-top">
                        {r.DUID}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                          r.BIDCATEGORY === "ENERGY" ? "bg-blue-500/15 text-blue-400" : "bg-purple-500/15 text-purple-400"
                        }`}>
                          {r.BIDCATEGORY}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-400 whitespace-nowrap align-top">
                        {r.BIDCATEGORY === "ENERGY" ? `${r.TOTALAVAIL.toFixed(0)}` : "—"}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="space-y-1">
                          {r.REBIDEXPLANATION ? (
                            <p className="text-zinc-400 leading-relaxed">{r.REBIDEXPLANATION}</p>
                          ) : (
                            <p className="text-zinc-600 italic">No reason given</p>
                          )}
                          {/* FCAS services */}
                          {r.FCAS_SERVICES.length > 0 && (
                            <div className="flex items-center gap-1 flex-wrap">
                              {r.FCAS_SERVICES.map((svc) => (
                                <span key={svc} className="text-[8px] font-mono px-1 py-0.5 rounded bg-purple-500/10 text-purple-400/70">
                                  {svc}
                                </span>
                              ))}
                            </div>
                          )}
                          {/* Band breakdown — Energy only */}
                          {r.BIDCATEGORY === "ENERGY" && r.BANDAVAIL.length > 0 && (
                            <div className="flex items-center gap-0.5 flex-wrap">
                              {r.BANDAVAIL.map((mw, bi) => {
                                if (mw === 0) return null;
                                const price = r.PRICEBAND[bi];
                                return (
                                  <span
                                    key={bi}
                                    className={`px-1 py-0.5 rounded text-[8px] font-mono ${
                                      price < 0 ? "bg-emerald-500/10 text-emerald-400" :
                                      price >= 300 ? "bg-rose-500/10 text-rose-400" :
                                      "bg-zinc-700/30 text-zinc-500"
                                    }`}
                                    title={`Band ${bi + 1}: ${mw} MW @ $${price}`}
                                  >
                                    {mw}@${price.toFixed(0)}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {r.REBIDEXPLANATION && (
                          <button
                            onClick={() => copyExplanation(r.REBIDEXPLANATION, i)}
                            className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
                            title="Copy reason"
                          >
                            {copiedIdx === i ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =======================================================================
// Price Spike Lookback — accumulates while server runs (24hr rolling)
// =======================================================================

interface SpikeRow {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  RRP: number;
  SEVERITY: "extreme" | "high" | "negative";
  BINDING_CONSTRAINTS: { CONSTRAINTID: string; MARGINALVALUE: number }[];
}

const SEVERITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  extreme:  { bg: "bg-red-500/15",    text: "text-red-400",     label: "EXTREME (>$1,000)" },
  high:     { bg: "bg-orange-500/15", text: "text-orange-400",  label: "HIGH (>$300)" },
  negative: { bg: "bg-cyan-500/15",   text: "text-cyan-400",    label: "NEGATIVE (\u2264-$30)" },
};

const LOOKBACK_OPTIONS = [
  { hours: 24, label: "24h" },
  { hours: 72, label: "3d" },
  { hours: 168, label: "7d" },
] as const;

function SpikesTab() {
  const [hours, setHours] = useState<number>(24);
  const [regionFilter, setRegionFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const { data, error, isLoading } = useSWR(`/api/analytics?tab=spikes&hours=${hours}`, fetcher, { refreshInterval: 30000 });

  const regions = useMemo(() => {
    if (!data?.spikes) return [];
    return [...new Set((data.spikes as SpikeRow[]).map((s) => s.REGIONID))].sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.spikes) return [];
    let rows = data.spikes as SpikeRow[];
    if (regionFilter !== "ALL") {
      rows = rows.filter((s) => s.REGIONID === regionFilter);
    }
    if (severityFilter !== "ALL") {
      rows = rows.filter((s) => s.SEVERITY === severityFilter);
    }
    return rows;
  }, [data, regionFilter, severityFilter]);

  const summary = useMemo(() => {
    if (!data?.spikes) return { extreme: 0, high: 0, negative: 0, total: 0 };
    const spikes = data.spikes as SpikeRow[];
    return {
      extreme: spikes.filter((s) => s.SEVERITY === "extreme").length,
      high: spikes.filter((s) => s.SEVERITY === "high").length,
      negative: spikes.filter((s) => s.SEVERITY === "negative").length,
      total: spikes.length,
    };
  }, [data]);

  if (error) return <p className="text-red-400 text-sm p-4">Failed to load</p>;
  if (!data) return <p className="text-zinc-500 text-sm p-4">Loading...</p>;

  return (
    <div className="space-y-3">
      {/* Header + lookback selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">Price Spike Lookback</span>
        <div className="flex items-center gap-1 ml-2">
          {LOOKBACK_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setHours(opt.hours)}
              className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${hours === opt.hours ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {isLoading && <span className="text-[10px] text-zinc-600 animate-pulse">loading...</span>}
        <span className="text-[10px] text-zinc-600 ml-auto">{hours * 12} dispatch intervals</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRegionFilter("ALL")}
            className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${regionFilter === "ALL" ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
          >
            All regions
          </button>
          {regions.map((r) => (
            <button
              key={r}
              onClick={() => setRegionFilter(r)}
              className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${regionFilter === r ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
            >
              {r.replace("1", "")}
            </button>
          ))}
        </div>

        <span className="text-zinc-700">|</span>

        <div className="flex items-center gap-1">
          {[
            { key: "ALL", label: `All (${summary.total})` },
            ...(summary.extreme > 0 ? [{ key: "extreme", label: `Extreme (${summary.extreme})` }] : []),
            ...(summary.high > 0 ? [{ key: "high", label: `High (${summary.high})` }] : []),
            ...(summary.negative > 0 ? [{ key: "negative", label: `Negative (${summary.negative})` }] : []),
          ].map((s) => (
            <button
              key={s.key}
              onClick={() => setSeverityFilter(s.key)}
              className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${severityFilter === s.key ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* No spikes message */}
      {filtered.length === 0 && (
        <p className="text-zinc-500 text-sm p-4">No price spikes detected</p>
      )}

      {/* Spike timeline */}
      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((s, i) => {
            const style = SEVERITY_STYLES[s.SEVERITY];
            return (
              <Card key={`${s.INTERVAL_DATETIME}-${s.REGIONID}-${i}`} className="rounded-xl">
                <CardContent className="px-4 py-3">
                  <div className="flex items-start gap-4">
                    {/* Time column */}
                    <div className="flex-shrink-0 text-right w-20">
                      <p className="text-[10px] text-zinc-500">{shortDateTime(s.INTERVAL_DATETIME)}</p>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                        <span className="font-mono text-sm font-semibold text-zinc-200">
                          {s.REGIONID.replace("1", "")}
                        </span>
                        <span className={`font-mono text-sm font-bold ${style.text}`}>
                          ${s.RRP.toFixed(2)}/MWh
                        </span>
                      </div>

                      {/* Binding constraints — the "cause" */}
                      {s.BINDING_CONSTRAINTS.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[9px] text-zinc-600 uppercase tracking-wide mb-1">Likely cause — binding constraints</p>
                          <div className="flex flex-wrap gap-1">
                            {s.BINDING_CONSTRAINTS.map((c, ci) => (
                              <span
                                key={ci}
                                className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-400"
                                title={`MV: $${c.MARGINALVALUE.toFixed(2)}/MWh`}
                              >
                                {c.CONSTRAINTID.length > 35 ? c.CONSTRAINTID.slice(0, 33) + "\u2026" : c.CONSTRAINTID}
                                <span className="ml-1 text-zinc-600">${c.MARGINALVALUE.toFixed(0)}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {s.BINDING_CONSTRAINTS.length === 0 && (
                        <p className="text-[9px] text-zinc-600 mt-1">No binding constraints at this interval</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =======================================================================
// BR Start Cost Analysis — Braemar model
// =======================================================================

interface StartIntervalRow {
  time: string;
  rrp: number;
  mw: number;
  gasCostInterval: number;
  revenue: number;
  margin: number;
  cumBalance: number;
}

interface StartAnalysisRow {
  startTime: string;
  intervals: StartIntervalRow[];
  recoveryTime: string | null;
  recoveryMinutes: number | null;
  finalBalance: number;
  peakBalance: number;
  optimalStopTime: string | null;
  optimalRunMinutes: number | null;
  optimalProfit: number;
}

interface StartCostData {
  config: { gasCostGJ: number; startCost: number; loadMW: number; heatRate: number; rampRateMWMin: number };
  regionId: string;
  srmc: number;
  allPrices: { time: string; rrp: number }[];
  analyses: StartAnalysisRow[];
  bestStart: StartAnalysisRow | null;
}

const DEFAULTS = {
  gasCostGJ: 11.5,
  startCost: 35000,
  loadMW: 170,
  heatRate: 10.4,
  rampRate: 11,
};

function ConfigInput({ label, unit, value, onChange, width }: { label: string; unit: string; value: string | number; onChange: (v: string) => void; width?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] text-zinc-500 whitespace-nowrap">{label}</label>
      <div className="flex items-center gap-0.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${width ?? "w-20"} bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700/50 rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500/50`}
        />
        <span className="text-[9px] text-zinc-600">{unit}</span>
      </div>
    </div>
  );
}

function StartCostTab() {
  const [gasCostGJ, setGasCostGJ] = useState(String(DEFAULTS.gasCostGJ));
  const [startCost, setStartCost] = useState(String(DEFAULTS.startCost));
  const [loadMW, setLoadMW] = useState(String(DEFAULTS.loadMW));
  const [heatRate, setHeatRate] = useState(String(DEFAULTS.heatRate));
  const [rampRate, setRampRate] = useState(String(DEFAULTS.rampRate));
  const [tradingDay, setTradingDay] = useState<"today" | "d+1">("today");
  const [selectedStart, setSelectedStart] = useState<number>(0);
  const [expandedStart, setExpandedStart] = useState<number | null>(null);
  const [showUnprofitable, setShowUnprofitable] = useState(false);

  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      tab: "startcost",
      region: "QLD1",
      gasCostGJ,
      startCost,
      loadMW,
      heatRate,
      rampRate,
      day: tradingDay,
    });
    return `/api/analytics?${params}`;
  }, [gasCostGJ, startCost, loadMW, heatRate, rampRate, tradingDay]);

  const { data, error } = useSWR(apiUrl, fetcher, { refreshInterval: 30000 });

  const result = data?.startcost as StartCostData | undefined;

  const computedSRMC = (Number(gasCostGJ) || 0) * (Number(heatRate) || 0);

  // Filter analyses: hide unprofitable by default
  const filteredAnalyses = useMemo(() => {
    if (!result?.analyses) return [];
    if (showUnprofitable) return result.analyses;
    return result.analyses.filter((a) => a.optimalProfit > 0);
  }, [result?.analyses, showUnprofitable]);

  const unprofitableCount = (result?.analyses?.length ?? 0) - filteredAnalyses.length;

  // Selected candidate analysis
  const selected = filteredAnalyses[selectedStart] ?? null;

  // Build chart data: price series with MW overlay from selected candidate
  const chartData = useMemo(() => {
    if (!result?.allPrices) return [];
    const mwMap = new Map<string, number>();
    if (selected) {
      for (const iv of selected.intervals) {
        mwMap.set(iv.time, iv.mw);
      }
    }
    return result.allPrices.map((p) => ({
      time: p.time,
      rrp: p.rrp,
      mw: mwMap.get(p.time) ?? null,
    }));
  }, [result?.allPrices, selected]);

  // Clamp selectedStart if analyses shrinks
  useEffect(() => {
    if (result?.analyses && selectedStart >= result.analyses.length) {
      setSelectedStart(0);
    }
  }, [result?.analyses, selectedStart]);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">BR Start Profitability</span>
        <span className="text-[10px] text-zinc-500">QLD1</span>
        <div className="flex items-center gap-1 ml-2">
          {(["today", "d+1"] as const).map((d) => (
            <button
              key={d}
              onClick={() => { setTradingDay(d); setSelectedStart(0); setExpandedStart(null); }}
              className={`px-2 py-1 text-[10px] rounded font-medium transition-colors ${tradingDay === d ? "bg-blue-500/15 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}
            >
              {d === "today" ? "Today" : "D+1"}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-zinc-600 ml-auto">
          {result?.allPrices?.length ?? 0} intervals (5min P5MIN + 30min PD)
        </span>
      </div>

      {/* Editable config */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-4 flex-wrap">
            <ConfigInput label="Gas" unit="$/GJ" value={gasCostGJ} onChange={setGasCostGJ} />
            <ConfigInput label="Heat Rate" unit="GJ/MWh" value={heatRate} onChange={setHeatRate} />
            <ConfigInput label="Load" unit="MW" value={loadMW} onChange={setLoadMW} />
            <ConfigInput label="Start Cost" unit="$" value={startCost} onChange={setStartCost} />
            <ConfigInput label="Ramp Rate" unit="MW/min" value={rampRate} onChange={setRampRate} />
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-[10px] text-zinc-500">SRMC:</span>
              <span className="text-[11px] font-mono font-semibold text-blue-400">${computedSRMC.toFixed(2)}/MWh</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-red-400 text-sm">Failed to load</p>}
      {!data && !error && <p className="text-zinc-500 text-sm">Loading...</p>}

      {/* Best start summary */}
      {selected && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-4 flex-wrap text-[11px]">
              <div>
                <span className="text-zinc-500">Start: </span>
                <span className="font-mono font-semibold text-blue-400">{shortDateTime(selected.startTime)}</span>
              </div>
              {selected.optimalStopTime && (
                <div>
                  <span className="text-zinc-500">Optimal off: </span>
                  <span className="font-mono font-semibold text-amber-400">{shortDateTime(selected.optimalStopTime)}</span>
                </div>
              )}
              {selected.optimalRunMinutes != null && (
                <div>
                  <span className="text-zinc-500">Run: </span>
                  <span className="font-mono font-semibold">{selected.optimalRunMinutes >= 60 ? `${(selected.optimalRunMinutes / 60).toFixed(1)}h` : `${selected.optimalRunMinutes}min`}</span>
                </div>
              )}
              <div>
                <span className="text-zinc-500">Max profit: </span>
                <span className={`font-mono font-semibold ${selected.optimalProfit > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {selected.optimalProfit > 0 ? "+" : ""}${selected.optimalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
              {selected.recoveryMinutes != null && (
                <div>
                  <span className="text-zinc-500">Recovers in: </span>
                  <span className="font-mono font-semibold text-emerald-400">{selected.recoveryMinutes}min</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Price chart with MW overlay */}
      {chartData.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-3 mb-2">
              <p className="text-[10px] text-zinc-500">
                QLD1 Price Forecast (P5MIN + PD) — SRMC ${(result?.srmc ?? computedSRMC).toFixed(2)}/MWh
              </p>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={chartData}>
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 9, fill: "#71717a" }}
                  tickFormatter={shortTime}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="price"
                  tick={{ fontSize: 9, fill: "#71717a" }}
                  tickFormatter={(v: number) => `$${v}`}
                  width={50}
                />
                <YAxis
                  yAxisId="mw"
                  orientation="right"
                  tick={{ fontSize: 9, fill: "#71717a" }}
                  tickFormatter={(v: number) => `${v}`}
                  width={40}
                  domain={[0, (Number(loadMW) || 170) * 1.2]}
                  label={{ value: "MW", angle: 90, position: "insideRight", style: { fontSize: 9, fill: "#52525b" } }}
                />
                <Tooltip content={<Tip />} />
                <ReferenceLine yAxisId="price" y={computedSRMC} stroke="#3b82f6" strokeDasharray="4 4" strokeOpacity={0.4} />
                {/* Price area */}
                <Area
                  yAxisId="price"
                  type="stepAfter"
                  dataKey="rrp"
                  name="RRP"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                  strokeWidth={1.5}
                />
                {/* MW output — run window */}
                <Area
                  yAxisId="mw"
                  type="stepAfter"
                  dataKey="mw"
                  name="MW"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Start analyses */}
      {result && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm font-semibold">Candidate Starts</span>
              <span className="text-[10px] text-zinc-500">
                {filteredAnalyses.length} profitable — click to overlay on chart
              </span>
              {unprofitableCount > 0 && (
                <button
                  onClick={() => { setShowUnprofitable(!showUnprofitable); setSelectedStart(0); }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors ml-auto"
                >
                  {showUnprofitable ? "Hide" : "Show"} {unprofitableCount} unprofitable
                </button>
              )}
            </div>

            {filteredAnalyses.length > 0 ? (
              <div className="space-y-0">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800">
                      <th className="text-left py-1 pr-2 font-medium">Start</th>
                      <th className="text-left py-1 pr-2 font-medium">Off</th>
                      <th className="text-right py-1 pr-2 font-medium">Run</th>
                      <th className="text-right py-1 pr-2 font-medium">Recovery</th>
                      <th className="text-right py-1 font-medium">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAnalyses.map((a, i) => (
                      <React.Fragment key={i}>
                        <tr
                          onClick={() => { setSelectedStart(i); setExpandedStart(expandedStart === i ? null : i); }}
                          className={`border-b border-zinc-800/50 cursor-pointer transition-colors ${
                            selectedStart === i ? "bg-blue-500/10" : ""
                          } ${
                            a.recoveryTime
                              ? "hover:bg-emerald-500/5"
                              : "hover:bg-zinc-800/30"
                          }`}
                        >
                          <td className="py-1 pr-2 font-mono">{shortDateTime(a.startTime)}</td>
                          <td className="py-1 pr-2 font-mono text-amber-400/80">
                            {a.optimalStopTime ? shortTime(a.optimalStopTime) : "—"}
                          </td>
                          <td className="py-1 pr-2 text-right font-mono">
                            {a.optimalRunMinutes != null
                              ? a.optimalRunMinutes >= 60
                                ? `${(a.optimalRunMinutes / 60).toFixed(1)}h`
                                : `${a.optimalRunMinutes}m`
                              : "—"}
                          </td>
                          <td className={`py-1 pr-2 text-right font-mono ${a.recoveryMinutes ? "text-emerald-400" : "text-zinc-600"}`}>
                            {a.recoveryMinutes ? `${a.recoveryMinutes}m` : "—"}
                          </td>
                          <td className={`py-1 text-right font-mono font-semibold ${a.optimalProfit > 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {a.optimalProfit > 0 ? "+" : ""}${a.optimalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        </tr>
                        {expandedStart === i && (
                          <tr key={`detail-${i}`}>
                            <td colSpan={5} className="p-0">
                              <div className="bg-zinc-900/50 border-y border-zinc-800/50">
                                {/* Interval table */}
                                <div className="max-h-48 overflow-y-auto px-3 py-2">
                                  <table className="w-full text-[10px]">
                                    <thead>
                                      <tr className="text-zinc-600">
                                        <th className="text-left py-0.5 pr-2">Time</th>
                                        <th className="text-right py-0.5 pr-2">MW</th>
                                        <th className="text-right py-0.5 pr-2">Price</th>
                                        <th className="text-right py-0.5 pr-2">Revenue</th>
                                        <th className="text-right py-0.5 pr-2">Gas Cost</th>
                                        <th className="text-right py-0.5 pr-2">Margin</th>
                                        <th className="text-right py-0.5">Balance</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {a.intervals.map((iv, j) => (
                                        <tr key={j} className={`border-t border-zinc-800/30 ${iv.cumBalance > 0 ? "text-emerald-400/80" : ""}`}>
                                          <td className="py-0.5 pr-2 font-mono">{shortTime(iv.time)}</td>
                                          <td className="py-0.5 pr-2 text-right font-mono">{iv.mw}</td>
                                          <td className="py-0.5 pr-2 text-right font-mono">${iv.rrp.toFixed(2)}</td>
                                          <td className="py-0.5 pr-2 text-right font-mono">${iv.revenue.toFixed(0)}</td>
                                          <td className="py-0.5 pr-2 text-right font-mono text-zinc-500">${iv.gasCostInterval.toFixed(0)}</td>
                                          <td className={`py-0.5 pr-2 text-right font-mono ${iv.margin > 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
                                            {iv.margin > 0 ? "+" : ""}${iv.margin.toFixed(0)}
                                          </td>
                                          <td className={`py-0.5 text-right font-mono font-semibold ${iv.cumBalance > 0 ? "text-emerald-400" : "text-red-400"}`}>
                                            ${iv.cumBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[10px] text-zinc-600">
                No profitable starts {tradingDay === "d+1" ? "for D+1" : "today"} (SRMC ${(result.srmc ?? computedSRMC).toFixed(2)}/MWh).
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =======================================================================
// Page
// =======================================================================

export default function AnalyticsPage() {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const dark = stored !== "light";
    setIsDark(dark);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("theme", next ? "dark" : "light");
      document.documentElement.classList.toggle("dark", next);
      document.documentElement.classList.toggle("light", !next);
      return next;
    });
  }, []);

  return (
    <div className="space-y-3">
      <Tabs defaultValue="rebids">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className="flex items-center justify-center h-7 w-7 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
          <span className="text-sm font-semibold">Analytics</span>
          <TabsList className="ml-2">
            <TabsTrigger value="rebids">Rebids</TabsTrigger>
            <TabsTrigger value="spikes">Price Spikes</TabsTrigger>
            <TabsTrigger value="startcost">BR Start</TabsTrigger>
          </TabsList>
          <button
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="ml-auto flex items-center justify-center h-7 w-7 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>

        <TabsContent value="rebids" className="mt-3"><RebidsTab /></TabsContent>
        <TabsContent value="spikes" className="mt-3"><SpikesTab /></TabsContent>
        <TabsContent value="startcost" className="mt-3"><StartCostTab /></TabsContent>
      </Tabs>
    </div>
  );
}
