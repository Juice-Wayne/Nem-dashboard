"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Copy, Check, RefreshCw, Sun, Moon, Pencil, Save, Plus, X, Thermometer, Wind, Zap, ArrowLeftRight, AlertTriangle, Clock, Filter } from "lucide-react";
import useSWR from "swr";
import { cn } from "@/lib/utils";
import { useAutoRefresh } from "@/lib/hooks/use-auto-refresh";
import { NemIntervalBar } from "@/components/nem-interval-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  Area, ReferenceLine,
  ComposedChart, CartesianGrid,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatCurrency, formatMW, formatMWDelta } from "@/lib/format";
import { INTERCONNECTORS, getInterconnectorName } from "@/lib/regions";

// --- Types ---

interface PDChange {
  INTERVAL_DATETIME?: string;
  DATETIME?: string;
  REGIONID: string;
  CURRENT_RRP: number;
  PREVIOUS_RRP: number;
  DELTA: number;
}

interface DemandChange {
  INTERVAL_DATETIME?: string;
  DATETIME?: string;
  REGIONID: string;
  CURRENT_TOTALDEMAND: number;
  PREVIOUS_TOTALDEMAND: number;
  DELTA: number;
}

interface InterconnectorChange {
  INTERVAL_DATETIME?: string;
  DATETIME?: string;
  INTERCONNECTORID: string;
  CURRENT_MWFLOW: number;
  PREVIOUS_MWFLOW: number;
  FLOW_DELTA: number;
  CURRENT_IMPORTLIMIT: number | null;
  PREVIOUS_IMPORTLIMIT: number | null;
  IMPORT_DELTA: number | null;
  CURRENT_EXPORTLIMIT: number | null;
  PREVIOUS_EXPORTLIMIT: number | null;
  EXPORT_DELTA: number | null;
}

interface SensitivityChange {
  INTERVAL_DATETIME?: string;
  DATETIME?: string;
  REGIONID: string;
  SCENARIO: string;
  DELTAMW: number | null;
  OFFSET_REGIONID: string | null;
  CURRENT_RRPSCENARIO: number;
  PREVIOUS_RRPSCENARIO: number;
  DELTA: number;
}

interface ActualPrice {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  FORECAST_RRP: number;
  ACTUAL_RRP: number;
  DELTA: number;
}

interface ActualDemand {
  INTERVAL_DATETIME: string;
  REGIONID: string;
  FORECAST_TOTALDEMAND: number;
  ACTUAL_TOTALDEMAND: number;
  DELTA: number;
}

interface ActualInterconnector {
  INTERVAL_DATETIME: string;
  INTERCONNECTORID: string;
  FORECAST_MWFLOW: number;
  ACTUAL_MWFLOW: number;
  FLOW_DELTA: number;
  FORECAST_IMPORTLIMIT: number | null;
  ACTUAL_IMPORTLIMIT: number | null;
  IMPORT_DELTA: number | null;
  FORECAST_EXPORTLIMIT: number | null;
  ACTUAL_EXPORTLIMIT: number | null;
  EXPORT_DELTA: number | null;
}

interface PDChangesData {
  p5min: PDChange[] | DemandChange[] | InterconnectorChange[] | SensitivityChange[];
  predispatch: PDChange[] | DemandChange[] | InterconnectorChange[] | SensitivityChange[];
}

interface AllPDChangesData {
  prices: PDChangesData;
  demand: PDChangesData;
  interconnectors: PDChangesData;
  sensitivities: PDChangesData;
}

interface ActualsData {
  prices: ActualPrice[];
  demand: ActualDemand[];
  interconnectors: ActualInterconnector[];
}

type RowCategory = "price" | "demand" | "interconnector" | "sensitivity" | "actual-price" | "actual-demand" | "actual-interconnector";

interface SelectedRow {
  source: "5PD" | "30PD" | "Actual";
  category: RowCategory;
  timeKey: string;
  label: string; // region or interconnector name
  // Price fields
  previousPrice?: number;
  currentPrice?: number;
  priceDelta?: number;
  // MW fields
  previousMW?: number;
  currentMW?: number;
  mwDelta?: number;
  // Sensitivity fields
  scenario?: string;
  // Actual fields
  forecast?: number;
  actual?: number;
}

const REGIONS = [
  { id: "QLD1", label: "QLD" },
  { id: "VIC1", label: "VIC" },
  { id: "NSW1", label: "NSW" },
  { id: "SA1", label: "SA" },
] as const;

const IC_OPTIONS = Object.entries(INTERCONNECTORS).map(([id, ic]) => ({
  id,
  label: ic.name,
}));

type Direction = "all" | "increase" | "decrease";

type WEMPrice = { DateTime: string; FinalPrice: number; isForecast: boolean };
type WEMDemand = { asAt: string; demandMW: number; withdrawalMW: number };
type WEMOfflineUnit = { facilityCode: string; offlineMW: number };
type WEMFacilityGen = { facilityCode: string; currentMW: number };
type WEMData = {
  prices: WEMPrice[] | null;
  demand: WEMDemand | null;
  offline: WEMOfflineUnit[] | null;
  generation: WEMFacilityGen[] | null;
};

type TabId = "prices" | "demand" | "interconnectors" | "sensitivities" | "actuals" | "spikes" | "startcost" | "market" | "wem";

// --- Helpers ---

/** Keyboard handler for clickable rows — triggers click on Enter/Space */
function rowKeyHandler(handler: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); }
  };
}

function formatShortTime(date: string): string {
  const d = new Date(date);
  return d.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatScenarioLabel(row: SensitivityChange): string {
  if (row.DELTAMW != null && row.OFFSET_REGIONID) {
    const regionShort = row.OFFSET_REGIONID.replace("1", "");
    const sign = row.DELTAMW > 0 ? "+" : "";
    return `${regionShort} ${sign}${Math.round(row.DELTAMW).toLocaleString()} MW`;
  }
  return row.SCENARIO;
}

function filterByRegion<T extends { REGIONID?: string }>(rows: T[], region: string): T[] {
  return rows.filter((r) => r.REGIONID === region);
}

function filterByInterconnector<T extends { INTERCONNECTORID?: string }>(rows: T[], icId: string): T[] {
  if (icId === "all") return rows;
  return rows.filter((r) => r.INTERCONNECTORID === icId);
}

function filterByDirection<T extends { DELTA?: number; FLOW_DELTA?: number }>(rows: T[], direction: Direction): T[] {
  return rows.filter((r) => {
    const delta = r.DELTA ?? r.FLOW_DELTA ?? 0;
    if (direction === "increase") return delta > 0;
    if (direction === "decrease") return delta < 0;
    return true;
  });
}

function sortByTime<T extends { INTERVAL_DATETIME?: string; DATETIME?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = a.INTERVAL_DATETIME ?? a.DATETIME ?? "";
    const tb = b.INTERVAL_DATETIME ?? b.DATETIME ?? "";
    return ta.localeCompare(tb);
  });
}

function getTimeKey(row: { INTERVAL_DATETIME?: string; DATETIME?: string }): string {
  return row.INTERVAL_DATETIME ?? row.DATETIME ?? "";
}

function buildReason(sel: SelectedRow): string {
  const time = formatShortTime(sel.timeKey);

  switch (sel.category) {
    case "price": {
      const dir = (sel.priceDelta ?? 0) > 0 ? "increased" : (sel.priceDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `Change in ${sel.source} price for ${sel.label} at ${time} \u2014 ${dir} by ${formatCurrency(Math.abs(sel.priceDelta ?? 0))} from ${formatCurrency(sel.previousPrice ?? 0)} to ${formatCurrency(sel.currentPrice ?? 0)} vs previous run.`;
    }
    case "demand": {
      const dir = (sel.mwDelta ?? 0) > 0 ? "increased" : (sel.mwDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `Change in ${sel.source} demand for ${sel.label} at ${time} \u2014 ${dir} by ${Math.abs(Math.round(sel.mwDelta ?? 0)).toLocaleString()} MW from ${formatMW(sel.previousMW)} to ${formatMW(sel.currentMW)} vs previous run.`;
    }
    case "interconnector": {
      const dir = (sel.mwDelta ?? 0) > 0 ? "increased" : (sel.mwDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `Change in ${sel.source} flow for ${sel.label} at ${time} \u2014 ${dir} by ${Math.abs(Math.round(sel.mwDelta ?? 0)).toLocaleString()} MW from ${formatMW(sel.previousMW)} to ${formatMW(sel.currentMW)} vs previous run.`;
    }
    case "sensitivity": {
      const dir = (sel.priceDelta ?? 0) > 0 ? "increased" : (sel.priceDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `Change in ${sel.source} price sensitivity (${sel.scenario}) for ${sel.label} at ${time} \u2014 ${dir} by ${formatCurrency(Math.abs(sel.priceDelta ?? 0))} from ${formatCurrency(sel.previousPrice ?? 0)} to ${formatCurrency(sel.currentPrice ?? 0)} vs previous run.`;
    }
    case "actual-price": {
      const dir = (sel.priceDelta ?? 0) > 0 ? "increased" : (sel.priceDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `5PD price forecast vs actual for ${sel.label} at ${time} \u2014 actual ${dir} by ${formatCurrency(Math.abs(sel.priceDelta ?? 0))} (forecast ${formatCurrency(sel.forecast ?? 0)}, actual ${formatCurrency(sel.actual ?? 0)}).`;
    }
    case "actual-demand": {
      const dir = (sel.mwDelta ?? 0) > 0 ? "increased" : (sel.mwDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `5PD demand forecast vs actual for ${sel.label} at ${time} \u2014 actual ${dir} by ${Math.abs(Math.round(sel.mwDelta ?? 0)).toLocaleString()} MW (forecast ${formatMW(sel.forecast)}, actual ${formatMW(sel.actual)}).`;
    }
    case "actual-interconnector": {
      const dir = (sel.mwDelta ?? 0) > 0 ? "increased" : (sel.mwDelta ?? 0) < 0 ? "decreased" : "unchanged";
      return `5PD flow forecast vs actual for ${sel.label} at ${time} \u2014 actual ${dir} by ${Math.abs(Math.round(sel.mwDelta ?? 0)).toLocaleString()} MW (forecast ${formatMW(sel.forecast)}, actual ${formatMW(sel.actual)}).`;
    }
  }
}

// --- Reusable delta cell color ---
function deltaColor(delta: number | null | undefined): string {
  if (delta == null) return "text-zinc-600";
  if (delta > 0) return "text-rose-400";
  if (delta < 0) return "text-emerald-400";
  return "text-zinc-600";
}

// --- WEM Tab ---

function WEMTab({ data }: { data: WEMData | null }) {
  const prices = data?.prices ?? [];
  // Split into actuals and forecasts for charting
  const actuals = prices.filter((p) => !p.isForecast);
  const forecasts = prices.filter((p) => p.isForecast);
  const latestActual = actuals.length ? actuals[actuals.length - 1] : null;
  const demand = data?.demand;

  // Build chart data: actuals have ActualPrice, forecasts have ForecastPrice
  const chartData = prices.map((p) => ({
    DateTime: p.DateTime,
    ActualPrice: p.isForecast ? null : p.FinalPrice,
    ForecastPrice: p.isForecast ? p.FinalPrice : null,
  }));

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="rounded-xl">
          <CardHeader><CardTitle className="text-base">Current Energy Price (AWST)</CardTitle></CardHeader>
          <CardContent>
            {latestActual ? (
              <div>
                <span className="text-3xl font-bold font-mono">{formatCurrency(latestActual.FinalPrice)}</span>
                <span className="text-sm text-zinc-500 ml-2">/MWh</span>
                <p className="text-xs text-zinc-500 mt-1">{latestActual.DateTime.slice(11, 16)} AWST</p>
                {forecasts.length > 0 && (
                  <p className="text-xs text-zinc-500 mt-0.5">Next: {formatCurrency(forecasts[0].FinalPrice)} @ {forecasts[0].DateTime.slice(11, 16)}</p>
                )}
              </div>
            ) : <LoadingState />}
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader><CardTitle className="text-base">Operational Demand</CardTitle></CardHeader>
          <CardContent>
            {demand ? (
              <div>
                <span className="text-3xl font-bold font-mono">{Math.round(demand.demandMW).toLocaleString()}</span>
                <span className="text-sm text-zinc-500 ml-2">MW</span>
                <p className="text-xs text-zinc-500 mt-1">Behind-the-meter: {Math.abs(Math.round(demand.withdrawalMW)).toLocaleString()} MW</p>
              </div>
            ) : <LoadingState />}
          </CardContent>
        </Card>
      </div>

      {/* Price chart — actuals (solid) + forecast (dashed) */}
      <Card className="rounded-xl">
        <CardHeader><CardTitle className="text-base">Energy Price — Today (5-min, AWST)</CardTitle></CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis
                    dataKey="DateTime"
                    tickFormatter={(v: string) => v.slice(11, 16)}
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                  />
                  <YAxis
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 }}
                    labelFormatter={(v: unknown) => String(v).slice(11, 16) + " AWST"}
                    formatter={(v: unknown, name: unknown) => [
                      `$${Number(v).toFixed(2)}/MWh`,
                      name === "ActualPrice" ? "Actual" : "Forecast",
                    ]}
                  />
                  <Area type="monotone" dataKey="ActualPrice" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} connectNulls={false} />
                  <Area type="monotone" dataKey="ForecastPrice" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.05} strokeDasharray="5 3" connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Page ---

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<TabId>("prices");
  const [region, setRegion] = useState<string>("QLD1");
  const [interconnector, setInterconnector] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [copiedReason, setCopiedReason] = useState(false);
  const [selectedRow, setSelectedRow] = useState<SelectedRow | null>(null);
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

  // Fetch all tab data eagerly in a single request (+ actuals separately)
  const {
    data: allChanges,
    isValidating: isRefreshingChanges,
    manualRefresh: refreshChanges,
    lastRefreshedAt: changesRefreshedAt,
  } = useAutoRefresh<AllPDChangesData>("/api/pd-changes?type=all");
  const {
    data: actualsData,
    isValidating: isRefreshingActuals,
    manualRefresh: refreshActuals,
    lastRefreshedAt: actualsRefreshedAt,
  } = useAutoRefresh<ActualsData>("/api/pd-vs-actual");

  const {
    data: wemData,
    isValidating: isRefreshingWEM,
  } = useAutoRefresh<WEMData>("/api/wem");

  const lastRefreshedAt = changesRefreshedAt ?? actualsRefreshedAt ?? null;

  const [manualRefreshing, setManualRefreshing] = useState(false);
  const isRefreshing = isRefreshingChanges || isRefreshingActuals || manualRefreshing;

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await Promise.all([refreshChanges(), refreshActuals()]);
    } finally {
      setManualRefreshing(false);
    }
  }, [refreshChanges, refreshActuals]);

  // Extract latest actual dispatch price per region
  const { regionPrices, dataInterval } = useMemo(() => {
    const shortNames: Record<string, string> = { QLD1: "Q", NSW1: "N", VIC1: "V", SA1: "S" };
    const order = ["QLD1", "NSW1", "VIC1", "SA1"];
    const actuals = (actualsData?.prices ?? []) as ActualPrice[];

    // Find the latest interval per region by sorting descending
    const priceMap = new Map<string, number>();
    let latestInterval: string | null = null;
    for (const row of actuals) {
      const dt = row.INTERVAL_DATETIME;
      // Keep the latest interval per region
      if (!priceMap.has(row.REGIONID) || (dt && dt > (latestInterval ?? ""))) {
        priceMap.set(row.REGIONID, row.ACTUAL_RRP);
      }
      if (!latestInterval || dt > latestInterval) {
        latestInterval = dt;
      }
    }

    return {
      regionPrices: order.map((id) => ({
        id,
        short: shortNames[id] ?? id,
        price: priceMap.get(id) ?? null,
      })),
      dataInterval: latestInterval,
    };
  }, [actualsData]);

  const priceData = allChanges?.prices ?? null;
  const demandData = allChanges?.demand ?? null;
  const icData = allChanges?.interconnectors ?? null;
  const sensData = allChanges?.sensitivities ?? null;

  const regionLabel = REGIONS.find((r) => r.id === region)?.label ?? region;

  // Generated rebid reason
  const generatedReason = useMemo(() => {
    if (!selectedRow) return "Select a row from the tables below.";
    return buildReason(selectedRow);
  }, [selectedRow]);

  const handleCopyReason = async () => {
    await navigator.clipboard.writeText(generatedReason);
    setCopiedReason(true);
    setTimeout(() => setCopiedReason(false), 2000);
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab as TabId);
    setSelectedRow(null);
  };

  const clearSelection = () => setSelectedRow(null);

  // Determine if we show region or interconnector selector
  const isAnalyticsTab = activeTab === "spikes" || activeTab === "startcost" || activeTab === "market" || activeTab === "wem";
  const showRegionSelector = !isAnalyticsTab && activeTab !== "interconnectors";
  const showInterconnectorSelector = activeTab === "interconnectors";
  const showFilters = !isAnalyticsTab;


  return (
    <div className="space-y-6 mt-1">
      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="relative flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-1">
            <TabsList>
              <TabsTrigger value="prices">Prices</TabsTrigger>
              <TabsTrigger value="demand">Demand</TabsTrigger>
              <TabsTrigger value="interconnectors">Interconnectors</TabsTrigger>
              <TabsTrigger value="sensitivities">Sensitivities</TabsTrigger>
              <TabsTrigger value="actuals">Actuals vs 5PD</TabsTrigger>
              <TabsTrigger value="spikes">Spikes</TabsTrigger>
              <TabsTrigger value="startcost">BR Start</TabsTrigger>
              <TabsTrigger value="market">Market</TabsTrigger>
              <TabsTrigger value="wem">WEM</TabsTrigger>
            </TabsList>
            <button
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              title={
                lastRefreshedAt
                  ? `Last updated: ${lastRefreshedAt.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Australia/Brisbane", timeZoneName: "short" })}`
                  : "Refresh data"
              }
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded-lg transition-all duration-150",
                "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]",
                isRefreshing && "text-zinc-400",
              )}
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
          </div>

          {/* NEM Interval countdown + current prices — absolutely centered on lg, below tabs on md */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto z-10 hidden lg:block">
            <NemIntervalBar
              regionPrices={regionPrices}
              lastRefreshedAt={lastRefreshedAt}
            />
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            {showFilters && showRegionSelector && (
              <Select value={region} onValueChange={(v) => { setRegion(v); setSelectedRow(null); }}>
                <SelectTrigger className="w-24 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGIONS.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showFilters && showInterconnectorSelector && (
              <Select value={interconnector} onValueChange={(v) => { setInterconnector(v); setSelectedRow(null); }}>
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {IC_OPTIONS.map((ic) => (
                    <SelectItem key={ic.id} value={ic.id}>{ic.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showFilters && activeTab !== "actuals" && (
              <Select value={direction} onValueChange={(v) => { setDirection(v as Direction); setSelectedRow(null); }}>
                <SelectTrigger className="w-28 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="increase">Increase</SelectItem>
                  <SelectItem value="decrease">Decrease</SelectItem>
                </SelectContent>
              </Select>
            )}
            {showFilters && selectedRow && (
              <button
                onClick={clearSelection}
                className="px-2 py-1 text-xs rounded-md font-medium text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
              >
                Clear
              </button>
            )}
            <div className="ml-2 flex items-center gap-1">
              <button
                onClick={toggleTheme}
                title={isDark ? "Switch to light mode" : "Switch to dark mode"}
                className="flex items-center justify-center h-8 w-8 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-all duration-150"
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* NEM Interval bar — mobile/tablet (below lg) */}
        <div className="lg:hidden mt-3">
          <NemIntervalBar
            regionPrices={regionPrices}
            lastRefreshedAt={lastRefreshedAt}
          />
        </div>

        {/* Rebid Reason Generator */}
        {showFilters && (
          <Card className="rounded-xl mt-4">
            <CardContent className="py-3">
              <div className="relative">
                <div className="rounded-md border border-input bg-white/[0.03] p-3 pr-12 text-sm font-mono text-zinc-200 min-h-[60px] whitespace-pre-wrap break-words">
                  {generatedReason}
                </div>
                <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" onClick={handleCopyReason}>
                  {copiedReason ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* === PRICES TAB === */}
        <TabsContent value="prices">
          <PricesTables
            data={priceData as { p5min: PDChange[]; predispatch: PDChange[] } | undefined}
            region={region}
            regionLabel={regionLabel}
            direction={direction}
            selectedRow={selectedRow}
            onSelect={setSelectedRow}
            actualInterval={dataInterval}
          />
        </TabsContent>

        {/* === DEMAND TAB === */}
        <TabsContent value="demand">
          <DemandTables
            data={demandData as { p5min: DemandChange[]; predispatch: DemandChange[] } | undefined}
            region={region}
            regionLabel={regionLabel}
            direction={direction}
            selectedRow={selectedRow}
            onSelect={setSelectedRow}
            actualInterval={dataInterval}
          />
        </TabsContent>

        {/* === INTERCONNECTORS TAB === */}
        <TabsContent value="interconnectors">
          <InterconnectorTables
            data={icData as { p5min: InterconnectorChange[]; predispatch: InterconnectorChange[] } | undefined}
            interconnector={interconnector}
            direction={direction}
            selectedRow={selectedRow}
            onSelect={setSelectedRow}
            actualInterval={dataInterval}
          />
        </TabsContent>

        {/* === SENSITIVITIES TAB === */}
        <TabsContent value="sensitivities">
          <SensitivityTables
            data={sensData as { p5min: SensitivityChange[]; predispatch: SensitivityChange[] } | undefined}
            region={region}
            regionLabel={regionLabel}
            direction={direction}
            selectedRow={selectedRow}
            onSelect={setSelectedRow}
          />
        </TabsContent>

        {/* === ACTUALS VS 5PD TAB === */}
        <TabsContent value="actuals">
          <ActualsTables
            data={actualsData}
            region={region}
            regionLabel={regionLabel}
            selectedRow={selectedRow}
            onSelect={setSelectedRow}
          />
        </TabsContent>

        {/* === PRICE SPIKES TAB === */}
        <TabsContent value="spikes">
          <SpikesTab />
        </TabsContent>

        {/* === BR START TAB === */}
        <TabsContent value="startcost">
          <StartCostTab />
        </TabsContent>

        {/* === MARKET ANALYSIS TAB === */}
        <TabsContent value="market" className="mt-4">
          <MarketAnalysisTab />
        </TabsContent>

        {/* === WEM TAB === */}
        <TabsContent value="wem" className="mt-4">
          <WEMTab data={wemData ?? null} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// PRICES TABLES (existing behavior, extracted to component)
// ============================================================

function PricesTables({
  data,
  region,
  regionLabel,
  direction,
  selectedRow,
  onSelect,
  actualInterval,
}: {
  data: { p5min: PDChange[]; predispatch: PDChange[] } | undefined;
  region: string;
  regionLabel: string;
  direction: Direction;
  selectedRow: SelectedRow | null;
  onSelect: (row: SelectedRow | null) => void;
  actualInterval?: string | null;
}) {
  const filtered5pd = useMemo(() => {
    if (!data?.p5min) return [];
    let rows = filterByDirection(filterByRegion(data.p5min, region), direction);
    // Only show intervals after the latest actual (these are forecasts, not actuals)
    if (actualInterval) {
      rows = rows.filter((r) => {
        const dt = r.INTERVAL_DATETIME ?? r.DATETIME ?? "";
        return dt > actualInterval;
      });
    }
    return sortByTime(rows);
  }, [data, region, direction, actualInterval]);

  const filtered30pd = useMemo(() => {
    if (!data?.predispatch) return [];
    const rows = filterByDirection(filterByRegion(data.predispatch, region), direction);
    // Skip first 2 intervals — 5PD already covers that range
    return sortByTime(rows).slice(2);
  }, [data, region, direction]);

  const handleSelect = (source: "5PD" | "30PD", row: PDChange) => {
    const tk = getTimeKey(row);
    if (selectedRow?.source === source && selectedRow?.timeKey === tk) {
      onSelect(null);
    } else {
      onSelect({
        source,
        category: "price",
        timeKey: tk,
        label: regionLabel,
        previousPrice: row.PREVIOUS_RRP,
        currentPrice: row.CURRENT_RRP,
        priceDelta: row.DELTA,
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">5-Min PD — {regionLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered5pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered5pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "5PD" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow key={`${tk}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("5PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatCurrency(row.PREVIOUS_RRP)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatCurrency(row.CURRENT_RRP)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {row.DELTA > 0 ? "+" : ""}{formatCurrency(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 5PD ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">30-Min PD — {regionLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered30pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered30pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "30PD" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow key={`${tk}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("30PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatCurrency(row.PREVIOUS_RRP)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatCurrency(row.CURRENT_RRP)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {row.DELTA > 0 ? "+" : ""}{formatCurrency(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 30PD ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// DEMAND TABLES
// ============================================================

function DemandTables({
  data,
  region,
  regionLabel,
  direction,
  selectedRow,
  onSelect,
  actualInterval,
}: {
  data: { p5min: DemandChange[]; predispatch: DemandChange[] } | undefined;
  region: string;
  regionLabel: string;
  direction: Direction;
  selectedRow: SelectedRow | null;
  onSelect: (row: SelectedRow | null) => void;
  actualInterval?: string | null;
}) {
  const filtered5pd = useMemo(() => {
    if (!data?.p5min) return [];
    let rows = filterByDirection(filterByRegion(data.p5min, region), direction);
    if (actualInterval) {
      rows = rows.filter((r) => {
        const dt = r.INTERVAL_DATETIME ?? r.DATETIME ?? "";
        return dt > actualInterval;
      });
    }
    return sortByTime(rows);
  }, [data, region, direction, actualInterval]);

  const filtered30pd = useMemo(() => {
    if (!data?.predispatch) return [];
    const rows = filterByDirection(filterByRegion(data.predispatch, region), direction);
    return sortByTime(rows).slice(2);
  }, [data, region, direction]);

  const handleSelect = (source: "5PD" | "30PD", row: DemandChange) => {
    const tk = getTimeKey(row);
    if (selectedRow?.source === source && selectedRow?.timeKey === tk) {
      onSelect(null);
    } else {
      onSelect({
        source,
        category: "demand",
        timeKey: tk,
        label: regionLabel,
        previousMW: row.PREVIOUS_TOTALDEMAND,
        currentMW: row.CURRENT_TOTALDEMAND,
        mwDelta: row.DELTA,
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">5-Min PD Demand — {regionLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered5pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">Previous (MW)</TableHead>
                      <TableHead className="text-right">Current (MW)</TableHead>
                      <TableHead className="text-right">Delta (MW)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered5pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "5PD" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow key={`${tk}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("5PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.PREVIOUS_TOTALDEMAND)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.CURRENT_TOTALDEMAND)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {formatMWDelta(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 5PD demand ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">30-Min PD Demand — {regionLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered30pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">Previous (MW)</TableHead>
                      <TableHead className="text-right">Current (MW)</TableHead>
                      <TableHead className="text-right">Delta (MW)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered30pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "30PD" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow key={`${tk}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("30PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.PREVIOUS_TOTALDEMAND)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.CURRENT_TOTALDEMAND)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {formatMWDelta(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 30PD demand ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// INTERCONNECTOR TABLES
// ============================================================

function InterconnectorTables({
  data,
  interconnector,
  direction,
  selectedRow,
  onSelect,
  actualInterval,
}: {
  data: { p5min: InterconnectorChange[]; predispatch: InterconnectorChange[] } | undefined;
  interconnector: string;
  direction: Direction;
  selectedRow: SelectedRow | null;
  onSelect: (row: SelectedRow | null) => void;
  actualInterval?: string | null;
}) {
  const icLabel = interconnector === "all" ? "All" : getInterconnectorName(interconnector);

  const filtered5pd = useMemo(() => {
    if (!data?.p5min) return [];
    let rows = filterByDirection(filterByInterconnector(data.p5min as InterconnectorChange[], interconnector), direction);
    if (actualInterval) {
      rows = rows.filter((r) => {
        const dt = r.INTERVAL_DATETIME ?? r.DATETIME ?? "";
        return dt > actualInterval;
      });
    }
    return sortByTime(rows);
  }, [data, interconnector, direction, actualInterval]);

  const filtered30pd = useMemo(() => {
    if (!data?.predispatch) return [];
    const rows = filterByDirection(filterByInterconnector(data.predispatch as InterconnectorChange[], interconnector), direction);
    return sortByTime(rows).slice(2);
  }, [data, interconnector, direction]);

  const handleSelect = (source: "5PD" | "30PD", row: InterconnectorChange) => {
    const tk = getTimeKey(row);
    if (selectedRow?.source === source && selectedRow?.timeKey === tk) {
      onSelect(null);
    } else {
      onSelect({
        source,
        category: "interconnector",
        timeKey: tk,
        label: getInterconnectorName(row.INTERCONNECTORID),
        previousMW: row.PREVIOUS_MWFLOW,
        currentMW: row.CURRENT_MWFLOW,
        mwDelta: row.FLOW_DELTA,
      });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">5-Min PD Interconnectors — {icLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered5pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead>IC</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered5pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "5PD" && selectedRow?.timeKey === tk && selectedRow?.label === getInterconnectorName(row.INTERCONNECTORID);
                      return (
                        <TableRow key={`${tk}-${row.INTERCONNECTORID}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("5PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-xs font-medium">{getInterconnectorName(row.INTERCONNECTORID)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.PREVIOUS_MWFLOW)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.CURRENT_MWFLOW)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.FLOW_DELTA)}`}>
                            {formatMWDelta(row.FLOW_DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 5PD IC ${direction !== "all" ? `${direction}s` : "changes"} for ${icLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">30-Min PD Interconnectors — {icLabel}</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered30pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead>IC</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered30pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "30PD" && selectedRow?.timeKey === tk && selectedRow?.label === getInterconnectorName(row.INTERCONNECTORID);
                      return (
                        <TableRow key={`${tk}-${row.INTERCONNECTORID}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("30PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-xs font-medium">{getInterconnectorName(row.INTERCONNECTORID)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.PREVIOUS_MWFLOW)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.CURRENT_MWFLOW)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.FLOW_DELTA)}`}>
                            {formatMWDelta(row.FLOW_DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 30PD IC ${direction !== "all" ? `${direction}s` : "changes"} for ${icLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// SENSITIVITY TABLES
// ============================================================

function SensitivityTables({
  data,
  region,
  regionLabel,
  direction,
  selectedRow,
  onSelect,
}: {
  data: { p5min: SensitivityChange[]; predispatch: SensitivityChange[] } | undefined;
  region: string;
  regionLabel: string;
  direction: Direction;
  selectedRow: SelectedRow | null;
  onSelect: (row: SelectedRow | null) => void;
}) {
  const filtered5pd = useMemo(() => {
    if (!data?.p5min) return [];
    const byRegion = data.p5min.filter((r) => r.OFFSET_REGIONID === region);
    return sortByTime(filterByDirection(byRegion, direction));
  }, [data, region, direction]);

  const filtered30pd = useMemo(() => {
    if (!data?.predispatch) return [];
    // Filter by OFFSET_REGIONID (the demand offset state shown in "Demand offset" column)
    // so the region selector filters by which state's demand was offset
    const byRegion = data.predispatch.filter((r) => r.OFFSET_REGIONID === region);
    return sortByTime(filterByDirection(byRegion, direction)).slice(2);
  }, [data, region, direction]);

  const handleSelect = (source: "5PD" | "30PD", row: SensitivityChange) => {
    const tk = getTimeKey(row);
    const scenarioLabel = formatScenarioLabel(row);
    if (selectedRow?.source === source && selectedRow?.timeKey === tk && selectedRow?.scenario === scenarioLabel) {
      onSelect(null);
    } else {
      onSelect({
        source,
        category: "sensitivity",
        timeKey: tk,
        label: regionLabel,
        scenario: scenarioLabel,
        previousPrice: row.PREVIOUS_RRPSCENARIO,
        currentPrice: row.CURRENT_RRPSCENARIO,
        priceDelta: row.DELTA,
      });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 mt-4">
      <Card className="rounded-xl">
        <CardHeader>
          <div>
            <CardTitle className="text-base">30-Min PD Sensitivities — {regionLabel} demand offset</CardTitle>
            {direction !== "all" && <p className="text-xs text-zinc-500 mt-1">{direction}s only</p>}
          </div>
        </CardHeader>
        <CardContent>
          {data ? (
            filtered30pd.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead>Demand offset</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered30pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "30PD" && selectedRow?.timeKey === tk && selectedRow?.scenario === formatScenarioLabel(row);
                      return (
                        <TableRow key={`${tk}-${row.SCENARIO}-${idx}`} tabIndex={0} role="button" onKeyDown={rowKeyHandler(() => handleSelect("30PD", row))} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
                          <TableCell className="font-mono text-xs">{tk ? formatShortTime(tk) : "\u2014"}</TableCell>
                          <TableCell className="text-xs font-medium font-mono">{formatScenarioLabel(row)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatCurrency(row.PREVIOUS_RRPSCENARIO)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatCurrency(row.CURRENT_RRPSCENARIO)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {row.DELTA > 0 ? "+" : ""}{formatCurrency(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No 30PD sensitivity ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel} demand offset`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// ACTUALS VS 5PD TABLES
// ============================================================

function ActualsTables({
  data,
  region,
  regionLabel,
  selectedRow,
  onSelect,
}: {
  data: ActualsData | undefined;
  region: string;
  regionLabel: string;
  selectedRow: SelectedRow | null;
  onSelect: (row: SelectedRow | null) => void;
}) {
  const filteredPrices = useMemo(() => {
    if (!data?.prices) return [];
    return sortByTime(filterByRegion(data.prices, region));
  }, [data, region]);

  const filteredDemand = useMemo(() => {
    if (!data?.demand) return [];
    return sortByTime(filterByRegion(data.demand, region));
  }, [data, region]);

  const filteredICs = useMemo(() => {
    if (!data?.interconnectors) return [];
    return sortByTime(data.interconnectors);
  }, [data]);

  return (
    <div className="space-y-6 mt-1">
      {/* Prices: Forecast vs Actual */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Prices — 5PD Forecast vs Actual — {regionLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          {data ? (
            filteredPrices.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">5PD Forecast</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredPrices.map((row, idx) => {
                      const tk = row.INTERVAL_DATETIME;
                      const sel = selectedRow?.source === "Actual" && selectedRow?.category === "actual-price" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow
                          key={`${tk}-${idx}`}
                          className={`cursor-pointer transition-colors ${sel ? "bg-amber-500/10" : ""}`}
                          onClick={() => {
                            if (sel) { onSelect(null); return; }
                            onSelect({
                              source: "Actual",
                              category: "actual-price",
                              timeKey: tk,
                              label: regionLabel,
                              forecast: row.FORECAST_RRP,
                              actual: row.ACTUAL_RRP,
                              priceDelta: row.DELTA,
                            });
                          }}
                        >
                          <TableCell className="font-mono text-xs">{formatShortTime(tk)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatCurrency(row.FORECAST_RRP)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatCurrency(row.ACTUAL_RRP)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {row.DELTA > 0 ? "+" : ""}{formatCurrency(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No actuals data for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>

      {/* Demand: Forecast vs Actual */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Demand — 5PD Forecast vs Actual — {regionLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          {data ? (
            filteredDemand.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead className="text-right">5PD Forecast (MW)</TableHead>
                      <TableHead className="text-right">Actual (MW)</TableHead>
                      <TableHead className="text-right">Delta (MW)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDemand.map((row, idx) => {
                      const tk = row.INTERVAL_DATETIME;
                      const sel = selectedRow?.source === "Actual" && selectedRow?.category === "actual-demand" && selectedRow?.timeKey === tk;
                      return (
                        <TableRow
                          key={`${tk}-${idx}`}
                          className={`cursor-pointer transition-colors ${sel ? "bg-amber-500/10" : ""}`}
                          onClick={() => {
                            if (sel) { onSelect(null); return; }
                            onSelect({
                              source: "Actual",
                              category: "actual-demand",
                              timeKey: tk,
                              label: regionLabel,
                              forecast: row.FORECAST_TOTALDEMAND,
                              actual: row.ACTUAL_TOTALDEMAND,
                              mwDelta: row.DELTA,
                            });
                          }}
                        >
                          <TableCell className="font-mono text-xs">{formatShortTime(tk)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.FORECAST_TOTALDEMAND)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.ACTUAL_TOTALDEMAND)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.DELTA)}`}>
                            {formatMWDelta(row.DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label={`No demand actuals for ${regionLabel}`} />
          ) : <LoadingState />}
        </CardContent>
      </Card>

      {/* Interconnectors: Forecast vs Actual */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Interconnectors — 5PD Forecast vs Actual</CardTitle>
        </CardHeader>
        <CardContent>
          {data ? (
            filteredICs.length > 0 ? (
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Interval</TableHead>
                      <TableHead>IC</TableHead>
                      <TableHead className="text-right">5PD Flow</TableHead>
                      <TableHead className="text-right">Actual Flow</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredICs.map((row, idx) => {
                      const tk = row.INTERVAL_DATETIME;
                      const icName = getInterconnectorName(row.INTERCONNECTORID);
                      const sel = selectedRow?.source === "Actual" && selectedRow?.category === "actual-interconnector" && selectedRow?.timeKey === tk && selectedRow?.label === icName;
                      return (
                        <TableRow
                          key={`${tk}-${row.INTERCONNECTORID}-${idx}`}
                          className={`cursor-pointer transition-colors ${sel ? "bg-amber-500/10" : ""}`}
                          onClick={() => {
                            if (sel) { onSelect(null); return; }
                            onSelect({
                              source: "Actual",
                              category: "actual-interconnector",
                              timeKey: tk,
                              label: icName,
                              forecast: row.FORECAST_MWFLOW,
                              actual: row.ACTUAL_MWFLOW,
                              mwDelta: row.FLOW_DELTA,
                            });
                          }}
                        >
                          <TableCell className="font-mono text-xs">{formatShortTime(tk)}</TableCell>
                          <TableCell className="text-xs font-medium">{icName}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-500">{formatMW(row.FORECAST_MWFLOW)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-sm text-zinc-200">{formatMW(row.ACTUAL_MWFLOW)}</TableCell>
                          <TableCell className={`text-right font-mono tabular-nums text-sm font-medium ${deltaColor(row.FLOW_DELTA)}`}>
                            {formatMWDelta(row.FLOW_DELTA)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : <EmptyState label="No IC actuals data" />
          ) : <LoadingState />}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// SWR fetcher for analytics tabs
// ============================================================

const analyticsFetcher = async (url: string) => {
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
function ChartTip({ active, payload, label }: any) {
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

// ============================================================
// Price Spike Lookback
// ============================================================

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
  const { data, error, isLoading, isValidating, mutate } = useSWR(`/api/analytics?tab=spikes&hours=${hours}`, analyticsFetcher, { refreshInterval: 30000 });

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

  if (error) return <div className="h-24 flex items-center justify-center text-red-400 text-sm">Failed to load spikes</div>;
  if (!data) return <div className="h-24 flex items-center justify-center text-zinc-500 text-sm animate-pulse">Loading spikes...</div>;

  return (
    <div className="space-y-3">
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
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-zinc-600">{hours * 12} dispatch intervals</span>
          <button
            onClick={() => mutate()}
            disabled={isValidating}
            className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={12} className={isValidating ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

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

      {filtered.length === 0 && (
        <p className="text-zinc-500 text-sm p-4">No price spikes detected</p>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((s, i) => {
            const style = SEVERITY_STYLES[s.SEVERITY];
            return (
              <Card key={`${s.INTERVAL_DATETIME}-${s.REGIONID}-${i}`} className="rounded-xl">
                <CardContent className="px-4 py-3">
                  <div className="flex items-start gap-4">
                    <div className="flex-shrink-0 text-right w-20">
                      <p className="text-[10px] text-zinc-500">{shortDateTime(s.INTERVAL_DATETIME)}</p>
                    </div>
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

// ============================================================
// BR Start Cost Analysis
// ============================================================

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
  sensScenario?: number;
  sensLabel?: string;
}

const QLD_SENS_SCENARIOS = [
  { rrpeep: 29, label: "QLD +100 MW" },
  { rrpeep: 30, label: "QLD -100 MW" },
  { rrpeep: 31, label: "QLD +200 MW" },
  { rrpeep: 32, label: "QLD -200 MW" },
  { rrpeep: 33, label: "QLD +500 MW" },
  { rrpeep: 34, label: "QLD -500 MW" },
];

const BR_DEFAULTS = {
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

const BR_STORAGE_KEY = "nem-br-config";

function loadBRConfig(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveBRConfig(cfg: Record<string, string>) {
  try { localStorage.setItem(BR_STORAGE_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

function usePersistentConfig(key: string, fallback: string): [string, (v: string) => void] {
  const [val, setVal] = useState(() => {
    const saved = loadBRConfig()[key];
    return saved !== undefined ? saved : fallback;
  });
  const update = useCallback((v: string) => {
    setVal(v);
    const cfg = loadBRConfig();
    cfg[key] = v;
    saveBRConfig(cfg);
  }, [key]);
  return [val, update];
}

function StartCostTab() {
  const [gasCostGJ, setGasCostGJ] = usePersistentConfig("gasCostGJ", String(BR_DEFAULTS.gasCostGJ));
  const [startCost, setStartCost] = usePersistentConfig("startCost", String(BR_DEFAULTS.startCost));
  const [loadMW, setLoadMW] = usePersistentConfig("loadMW", String(BR_DEFAULTS.loadMW));
  const [heatRate, setHeatRate] = usePersistentConfig("heatRate", String(BR_DEFAULTS.heatRate));
  const [rampRate, setRampRate] = usePersistentConfig("rampRate", String(BR_DEFAULTS.rampRate));
  const [tradingDay, setTradingDay] = useState<"today" | "d+1">("today");
  const [sensScenario, setSensScenario] = useState<number | 0>(0);
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
    if (sensScenario) params.set("sensScenario", String(sensScenario));
    return `/api/analytics?${params}`;
  }, [gasCostGJ, startCost, loadMW, heatRate, rampRate, tradingDay, sensScenario]);

  const { data, error, isValidating, mutate } = useSWR(apiUrl, analyticsFetcher, { refreshInterval: 30000 });

  const result = data?.startcost as StartCostData | undefined;

  const computedSRMC = (Number(gasCostGJ) || 0) * (Number(heatRate) || 0);

  const filteredAnalyses = useMemo(() => {
    if (!result?.analyses) return [];
    if (showUnprofitable) return result.analyses;
    return result.analyses.filter((a) => a.optimalProfit > 0);
  }, [result?.analyses, showUnprofitable]);

  const unprofitableCount = (result?.analyses?.length ?? 0) - filteredAnalyses.length;

  const selected = filteredAnalyses[selectedStart] ?? null;

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

  useEffect(() => {
    if (result?.analyses && selectedStart >= result.analyses.length) {
      setSelectedStart(0);
    }
  }, [result?.analyses, selectedStart]);

  return (
    <div className="space-y-3">
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
        <div className="flex items-center gap-1 ml-2">
          <span className="text-[10px] text-zinc-500">Price:</span>
          <select
            value={sensScenario}
            onChange={(e) => { setSensScenario(Number(e.target.value)); setSelectedStart(0); setExpandedStart(null); }}
            className="bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700/50 rounded px-1.5 py-0.5 text-[10px] font-mono text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500/50"
          >
            <option value={0}>Base RRP</option>
            {QLD_SENS_SCENARIOS.map((s) => (
              <option key={s.rrpeep} value={s.rrpeep}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-zinc-600">
            {result?.allPrices?.length ?? 0} intervals {sensScenario ? "(30min PD sensitivity)" : "(5min P5MIN + 30min PD)"}
          </span>
          <button
            onClick={() => mutate()}
            disabled={isValidating}
            className="p-1 rounded hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={12} className={isValidating ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-4 flex-wrap">
            <ConfigInput label="Gas" unit="$/GJ" value={gasCostGJ} onChange={setGasCostGJ} />
            <ConfigInput label="Heat Rate" unit="GJ/MWh" value={heatRate} onChange={setHeatRate} />
            <ConfigInput label="Load" unit="MW" value={loadMW} onChange={setLoadMW} />
            <ConfigInput label="Start Cost" unit="$" value={startCost} onChange={setStartCost} />
            <ConfigInput label="Ramp Rate" unit="MW/min" value={rampRate} onChange={setRampRate} />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500">SRMC:</span>
              <span className="text-[11px] font-mono font-semibold text-blue-400">${computedSRMC.toFixed(2)}/MWh</span>
            </div>
            {selected && (
              <>
                <div className="w-px h-8 bg-zinc-500/60 mx-2" />
                <div className="flex items-center gap-3 flex-wrap text-[11px]">
                  {sensScenario > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 text-[9px] font-medium">
                      {QLD_SENS_SCENARIOS.find(s => s.rrpeep === sensScenario)?.label ?? `RRPEEP${sensScenario}`}
                    </span>
                  )}
                  <div>
                    <span className="text-zinc-500">Start: </span>
                    <span className="font-mono font-semibold text-blue-400">{shortDateTime(selected.startTime)}</span>
                  </div>
                  {selected.optimalStopTime && (
                    <div>
                      <span className="text-zinc-500">Off: </span>
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
                    <span className="text-zinc-500">Profit: </span>
                    <span className={`font-mono font-semibold ${selected.optimalProfit > 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {selected.optimalProfit > 0 ? "+" : ""}${selected.optimalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  {selected.recoveryMinutes != null && (
                    <div>
                      <span className="text-zinc-500">Recovery: </span>
                      <span className="font-mono font-semibold text-emerald-400">{selected.recoveryMinutes}min</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {error && <div className="h-24 flex items-center justify-center text-red-400 text-sm">Failed to load start analysis</div>}
      {!data && !error && <div className="h-24 flex items-center justify-center text-zinc-500 text-sm animate-pulse">Loading start analysis...</div>}

      {chartData.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="mb-1" />
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
                <Tooltip content={<ChartTip />} />
                <ReferenceLine yAxisId="price" y={computedSRMC} stroke="#3b82f6" strokeDasharray="4 4" strokeOpacity={0.8} strokeWidth={1.5} />
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

      {result && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-3 mb-2">
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
                            {a.optimalStopTime ? shortTime(a.optimalStopTime) : "\u2014"}
                          </td>
                          <td className="py-1 pr-2 text-right font-mono">
                            {a.optimalRunMinutes != null
                              ? a.optimalRunMinutes >= 60
                                ? `${(a.optimalRunMinutes / 60).toFixed(1)}h`
                                : `${a.optimalRunMinutes}m`
                              : "\u2014"}
                          </td>
                          <td className={`py-1 pr-2 text-right font-mono ${a.recoveryMinutes ? "text-emerald-400" : "text-zinc-600"}`}>
                            {a.recoveryMinutes ? `${a.recoveryMinutes}m` : "\u2014"}
                          </td>
                          <td className={`py-1 text-right font-mono font-semibold ${a.optimalProfit > 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {a.optimalProfit > 0 ? "+" : ""}${a.optimalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        </tr>
                        {expandedStart === i && (
                          <tr key={`detail-${i}`}>
                            <td colSpan={5} className="p-0">
                              <div className="bg-zinc-900/50 border-y border-zinc-800/50">
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
                No profitable starts {tradingDay === "d+1" ? "for D+1" : "today"}{sensScenario ? ` using ${QLD_SENS_SCENARIOS.find(s => s.rrpeep === sensScenario)?.label ?? "sensitivity"} prices` : ""} (SRMC ${(result.srmc ?? computedSRMC).toFixed(2)}/MWh).
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// Shared small components
// ============================================================

function EmptyState({ label }: { label: string }) {
  return (
    <div className="h-24 flex items-center justify-center text-zinc-500">
      {label}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="h-24 flex items-center justify-center text-zinc-500">
      Loading...
    </div>
  );
}

// ============================================================
// Market Analysis Tab
// ============================================================

interface MarketOutageUI {
  duid: string;
  stationName: string;
  region: string;
  fuel: string;
  maxCapacity: number;
  currentOutput: number;
  availableMW: number;
  reductionMW: number;
  type: "full" | "partial";
  expectedReturn: string | null;
}

interface MarketRegionSummaryUI {
  region: string;
  peakDemand: number;
  currentDemand: number;
  solarMW: number;
  solarNowMW: number;
  windMW: number;
  windNowMW: number;
  rooftopPvMW: number;
  totalRenewablesMW: number;
}

interface MarketICBindingUI {
  interconnectorId: string;
  name: string;
  direction: string;
  intervals: number;
  totalIntervals: number;
  avgFlowMW: number;
  bindingFrom: string;
  bindingTo: string;
  bindingDescription: string;
}

interface MarketUpcomingOutageUI {
  duid: string;
  stationName: string;
  region: string;
  fuel: string;
  maxCapacity: number;
  outageStart: string;
  expectedReturn: string | null;
}

interface MarketSummaryData {
  regions: MarketRegionSummaryUI[];
  interconnectors: MarketICBindingUI[];
  outages: MarketOutageUI[];
  upcomingOutages: MarketUpcomingOutageUI[];
  temps: Record<string, number | null>;
  timestamp: string;
}

// Manual overrides stored in localStorage (temps, notes — not on NEMWeb)
interface MarketManualData {
  date: string;
  temps: Record<string, string>;   // region → "26°C"
  notes: Record<string, string>;   // region → "high cloud 89%"
}

const MANUAL_STORAGE_KEY = "nem-market-manual";

function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
}

function loadManualData(): MarketManualData {
  try {
    const raw = localStorage.getItem(MANUAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MarketManualData;
      if (parsed.date === getToday()) return parsed;
    }
  } catch { /* ignore */ }
  return { date: getToday(), temps: {}, notes: {} };
}

function saveManualData(data: MarketManualData) {
  localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify({ ...data, date: getToday() }));
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Map interconnector direction ("north"/"south") to destination state
const IC_DIRECTION_TO_STATE: Record<string, Record<string, string>> = {
  "QNI":        { north: "to QLD", south: "to NSW" },
  "Terranora":  { north: "to QLD", south: "to NSW" },
  "VNI":        { north: "to NSW", south: "to VIC" },
  "Heywood":    { north: "to VIC", south: "to SA" },
  "Murraylink": { north: "to VIC", south: "to SA" },
};

function icDirectionLabel(name: string, direction: string): string {
  return IC_DIRECTION_TO_STATE[name]?.[direction] ?? direction;
}

type MarketTextStyle = "compact" | "dot-point" | "narrative" | "table";

function buildMarketText(market: MarketSummaryData, manual: MarketManualData, outageFuels?: Set<string>, icFilter?: Set<string>, style: MarketTextStyle = "compact"): string {
  const dateStr = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", year: "numeric",
  });

  // --- Shared data prep ---
  const regionData = market.regions.map((r) => {
    const regionKey = r.region.replace("1", "");
    const manualTemp = manual.temps[r.region] || manual.temps[regionKey];
    const apiTemp = market.temps?.[regionKey];
    const temp = manualTemp || (apiTemp != null ? `${apiTemp}°C` : null);
    const notes = manual.notes[r.region] || null;
    return { ...r, regionKey, temp, notes };
  });

  const filteredICs = (market.interconnectors ?? []).filter((ic) => !icFilter || icFilter.has(ic.name));

  const filteredOutages = (market.outages ?? []).filter((o) => {
    if (o.region.startsWith("SA") || o.region.startsWith("TAS")) return false;
    if (outageFuels && !outageFuels.has(o.fuel)) return false;
    return true;
  });

  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const filteredUpcoming = (market.upcomingOutages ?? []).filter((o) => {
    if (o.region.startsWith("SA") || o.region.startsWith("TAS")) return false;
    if (outageFuels && !outageFuels.has(o.fuel)) return false;
    const startMs = new Date(o.outageStart.replace(/\//g, "-")).getTime();
    return startMs - nowMs <= fourteenDaysMs;
  });

  const fmtDate = (s: string) => new Date(s.replace(/\//g, "-")).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" });

  function groupByRegion<T extends { region: string }>(items: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const o of items) {
      const key = o.region.replace("1", "");
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(o);
    }
    return m;
  }

  function outageLabel(o: MarketOutageUI) {
    return o.type === "full" ? "outage" : `partial outage (${o.availableMW}/${o.maxCapacity}MW)`;
  }

  // --- Style 1: Compact (default) ---
  if (style === "compact") {
    const lines: string[] = [`**Market Analysis — ${dateStr}**`, ""];
    for (const r of regionData) {
      const parts: string[] = [];
      if (r.temp) parts.push(`max temp ${r.temp}`);
      if (r.windMW > 0 || r.windNowMW > 0) parts.push(`wind ${r.windNowMW.toLocaleString()}MW now, ${r.windMW.toLocaleString()}MW peak`);
      if (r.solarMW > 0 || r.solarNowMW > 0) parts.push(`solar ${r.solarNowMW.toLocaleString()}MW now, ${r.solarMW.toLocaleString()}MW peak`);
      parts.push(`demand ${r.peakDemand.toLocaleString()}MW`);
      if (r.notes) parts.push(r.notes);
      lines.push(`**${r.regionKey}**: ${parts.join(", ")}`);
    }
    if (filteredICs.length > 0) {
      lines.push("", "**Interconnectors**");
      for (const ic of filteredICs) lines.push(`${ic.name} binding ${icDirectionLabel(ic.name, ic.direction)} ${ic.bindingDescription || ""}`.trim());
    }
    if (filteredOutages.length > 0) {
      lines.push("", "**Outages**");
      for (const [region, outages] of groupByRegion(filteredOutages)) {
        lines.push(`**${region}**`);
        for (const o of outages) {
          const ret = o.expectedReturn ? ` till ${fmtDate(o.expectedReturn)}` : "";
          lines.push(`${o.duid}: ${outageLabel(o)}${ret}`);
        }
      }
    }
    if (filteredUpcoming.length > 0) {
      lines.push("", "**Upcoming Outages**");
      for (const [region, upcoming] of groupByRegion(filteredUpcoming)) {
        lines.push(`**${region}**`);
        for (const o of upcoming) {
          const ret = o.expectedReturn ? ` to ${fmtDate(o.expectedReturn)}` : "";
          lines.push(`${o.duid}: out from ${fmtDate(o.outageStart)}${ret}`);
        }
      }
    }
    return lines.join("\n");
  }

  // --- Style 2: Dot point ---
  if (style === "dot-point") {
    const lines: string[] = [`**Market Analysis — ${dateStr}**`];
    for (const r of regionData) {
      lines.push("", `**${r.regionKey}**`);
      if (r.temp) lines.push(`  - Max temp: ${r.temp}`);
      if (r.windMW > 0 || r.windNowMW > 0) lines.push(`  - Wind: ${r.windNowMW.toLocaleString()}MW now, ${r.windMW.toLocaleString()}MW peak`);
      if (r.solarMW > 0 || r.solarNowMW > 0) lines.push(`  - Solar: ${r.solarNowMW.toLocaleString()}MW now, ${r.solarMW.toLocaleString()}MW peak`);
      lines.push(`  - Demand: ${r.peakDemand.toLocaleString()}MW peak, ${r.currentDemand.toLocaleString()}MW now`);
      if (r.notes) lines.push(`  - ${r.notes}`);
    }
    if (filteredICs.length > 0) {
      lines.push("", "**Interconnectors**");
      for (const ic of filteredICs) lines.push(`  - ${ic.name} binding ${icDirectionLabel(ic.name, ic.direction)} ${ic.bindingDescription || ""}`.trim());
    }
    if (filteredOutages.length > 0) {
      lines.push("", "**Outages**");
      for (const [region, outages] of groupByRegion(filteredOutages)) {
        lines.push(`  **${region}**`);
        for (const o of outages) {
          const ret = o.expectedReturn ? ` till ${fmtDate(o.expectedReturn)}` : "";
          lines.push(`    - ${o.duid}: ${outageLabel(o)}${ret}`);
        }
      }
    }
    if (filteredUpcoming.length > 0) {
      lines.push("", "**Upcoming Outages**");
      for (const [region, upcoming] of groupByRegion(filteredUpcoming)) {
        lines.push(`  **${region}**`);
        for (const o of upcoming) {
          const ret = o.expectedReturn ? ` to ${fmtDate(o.expectedReturn)}` : "";
          lines.push(`    - ${o.duid}: out from ${fmtDate(o.outageStart)}${ret}`);
        }
      }
    }
    return lines.join("\n");
  }

  // --- Style 3: Narrative ---
  if (style === "narrative") {
    const lines: string[] = [`**Market Analysis — ${dateStr}**`, ""];
    const regionNames: Record<string, string> = { NSW: "New South Wales", QLD: "Queensland", VIC: "Victoria", SA: "South Australia" };
    for (const r of regionData) {
      const name = regionNames[r.regionKey] ?? r.regionKey;
      const parts: string[] = [];
      if (r.temp) parts.push(`a forecast maximum of ${r.temp}`);
      parts.push(`demand is expected to peak at ${r.peakDemand.toLocaleString()}MW and is currently sitting at ${r.currentDemand.toLocaleString()}MW`);
      if (r.windMW > 0 || r.windNowMW > 0) parts.push(`wind generation is currently ${r.windNowMW.toLocaleString()}MW with a forecast peak of ${r.windMW.toLocaleString()}MW`);
      if (r.solarMW > 0 || r.solarNowMW > 0) parts.push(`solar is at ${r.solarNowMW.toLocaleString()}MW now with a peak forecast of ${r.solarMW.toLocaleString()}MW`);
      if (r.notes) parts.push(r.notes);
      lines.push(`**${name}** has ${parts.join(". ")}.`);
      lines.push("");
    }
    if (filteredICs.length > 0) {
      const icParts = filteredICs.map((ic) => `${ic.name} is binding ${icDirectionLabel(ic.name, ic.direction)} ${ic.bindingDescription || ""}`.trim());
      lines.push(`On the interconnectors, ${icParts.join("; ")}.`);
      lines.push("");
    }
    if (filteredOutages.length > 0) {
      const outageParts: string[] = [];
      for (const [region, outages] of groupByRegion(filteredOutages)) {
        const units = outages.map((o) => {
          const ret = o.expectedReturn ? ` (returning ${fmtDate(o.expectedReturn)})` : "";
          return `${o.duid}${ret}`;
        });
        outageParts.push(`in ${region}: ${units.join(", ")}`);
      }
      lines.push(`Current outages include ${outageParts.join("; ")}.`);
      lines.push("");
    }
    if (filteredUpcoming.length > 0) {
      const upParts: string[] = [];
      for (const [region, upcoming] of groupByRegion(filteredUpcoming)) {
        const units = upcoming.map((o) => {
          const ret = o.expectedReturn ? ` to ${fmtDate(o.expectedReturn)}` : "";
          return `${o.duid} from ${fmtDate(o.outageStart)}${ret}`;
        });
        upParts.push(`in ${region}: ${units.join(", ")}`);
      }
      lines.push(`Upcoming planned outages: ${upParts.join("; ")}.`);
    }
    return lines.join("\n");
  }

  // --- Style 4: Table (space-aligned for monospace) ---
  {
    const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
    const lines: string[] = [`**Market Analysis — ${dateStr}**`, ""];

    // Region table
    const cols = ["Region", "Temp", "Wind Now", "Wind Pk", "Solar Now", "Solar Pk", "Demand"];
    const rows = regionData.map((r) => [
      r.regionKey,
      r.temp ?? "-",
      (r.windNowMW > 0 || r.windMW > 0) ? `${r.windNowMW.toLocaleString()}` : "-",
      r.windMW > 0 ? `${r.windMW.toLocaleString()}` : "-",
      (r.solarNowMW > 0 || r.solarMW > 0) ? `${r.solarNowMW.toLocaleString()}` : "-",
      r.solarMW > 0 ? `${r.solarMW.toLocaleString()}` : "-",
      `${r.peakDemand.toLocaleString()}`,
    ]);
    const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
    lines.push(cols.map((c, i) => pad(c, widths[i])).join("  "));
    lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    for (const row of rows) lines.push(row.map((c, i) => pad(c, widths[i])).join("  "));

    // IC table
    if (filteredICs.length > 0) {
      lines.push("", "**Interconnectors**");
      const icCols = ["Name", "Direction", "Period"];
      const icRows = filteredICs.map((ic) => [ic.name, icDirectionLabel(ic.name, ic.direction), ic.bindingDescription || "all day"]);
      const icW = icCols.map((c, i) => Math.max(c.length, ...icRows.map((r) => r[i].length)));
      lines.push(icCols.map((c, i) => pad(c, icW[i])).join("  "));
      lines.push(icW.map((w) => "-".repeat(w)).join("  "));
      for (const row of icRows) lines.push(row.map((c, i) => pad(c, icW[i])).join("  "));
    }

    // Outage table
    if (filteredOutages.length > 0) {
      lines.push("", "**Outages**");
      const oCols = ["Unit", "Region", "Status", "Return"];
      const oRows = filteredOutages.map((o) => [o.duid, o.region.replace("1", ""), outageLabel(o), o.expectedReturn ? fmtDate(o.expectedReturn) : "-"]);
      const oW = oCols.map((c, i) => Math.max(c.length, ...oRows.map((r) => r[i].length)));
      lines.push(oCols.map((c, i) => pad(c, oW[i])).join("  "));
      lines.push(oW.map((w) => "-".repeat(w)).join("  "));
      for (const row of oRows) lines.push(row.map((c, i) => pad(c, oW[i])).join("  "));
    }

    // Upcoming table
    if (filteredUpcoming.length > 0) {
      lines.push("", "**Upcoming Outages**");
      const uCols = ["Unit", "Region", "From", "To"];
      const uRows = filteredUpcoming.map((o) => [o.duid, o.region.replace("1", ""), fmtDate(o.outageStart), o.expectedReturn ? fmtDate(o.expectedReturn) : "-"]);
      const uW = uCols.map((c, i) => Math.max(c.length, ...uRows.map((r) => r[i].length)));
      lines.push(uCols.map((c, i) => pad(c, uW[i])).join("  "));
      lines.push(uW.map((w) => "-".repeat(w)).join("  "));
      for (const row of uRows) lines.push(row.map((c, i) => pad(c, uW[i])).join("  "));
    }

    return lines.join("\n");
  }
}

function buildMarketTableHtml(market: MarketSummaryData, manual: MarketManualData, outageFuels?: Set<string>, icFilter?: Set<string>, dark = false): string {
  const dateStr = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  const border = dark ? "#333" : "#ccc";
  const thBg = dark ? "#1a1a1a" : "#f5f5f5";
  const thColor = dark ? "#e4e4e7" : "inherit";
  const tdColor = dark ? "#a1a1aa" : "inherit";
  const ts = `style="border:1px solid ${border};padding:4px 8px;text-align:left;color:${tdColor}"`;
  const ths = `style="border:1px solid ${border};padding:4px 8px;text-align:left;font-weight:bold;background:${thBg};color:${thColor}"`;
  const tbl = `style="border-collapse:collapse;font-size:11px;font-family:ui-monospace,monospace"`;

  function table(headers: string[], rows: string[][]): string {
    const hdr = headers.map((h) => `<th ${ths}>${h}</th>`).join("");
    const body = rows.map((r) => "<tr>" + r.map((c) => `<td ${ts}>${c}</td>`).join("") + "</tr>").join("");
    return `<table ${tbl}><tr>${hdr}</tr>${body}</table>`;
  }

  const fmtDate = (s: string) => new Date(s.replace(/\//g, "-")).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" });

  const bStyle = dark ? ' style="color:#e4e4e7"' : '';
  const parts: string[] = [`<b${bStyle}>Market Analysis — ${dateStr}</b><br><br>`];

  // Region table
  const regionRows = market.regions.map((r) => {
    const regionKey = r.region.replace("1", "");
    const manualTemp = manual.temps[r.region] || manual.temps[regionKey];
    const apiTemp = market.temps?.[regionKey];
    const temp = manualTemp || (apiTemp != null ? `${apiTemp}°C` : "-");
    return [
      `<b>${regionKey}</b>`,
      temp,
      (r.windNowMW > 0 || r.windMW > 0) ? r.windNowMW.toLocaleString() : "-",
      r.windMW > 0 ? r.windMW.toLocaleString() : "-",
      (r.solarNowMW > 0 || r.solarMW > 0) ? r.solarNowMW.toLocaleString() : "-",
      r.solarMW > 0 ? r.solarMW.toLocaleString() : "-",
      r.peakDemand.toLocaleString(),
    ];
  });
  parts.push(table(["Region", "Temp", "Wind Now", "Wind Peak", "Solar Now", "Solar Peak", "Demand MW"], regionRows));

  // IC table
  const filteredICs = (market.interconnectors ?? []).filter((ic) => !icFilter || icFilter.has(ic.name));
  if (filteredICs.length > 0) {
    parts.push(`<br><b${bStyle}>Interconnectors</b><br>`);
    const icRows = filteredICs.map((ic) => [ic.name, icDirectionLabel(ic.name, ic.direction), ic.bindingDescription || "all day"]);
    parts.push(table(["Name", "Direction", "Period"], icRows));
  }

  // Outage table
  const filteredOutages = (market.outages ?? []).filter((o) => {
    if (o.region.startsWith("SA") || o.region.startsWith("TAS")) return false;
    if (outageFuels && !outageFuels.has(o.fuel)) return false;
    return true;
  });
  if (filteredOutages.length > 0) {
    parts.push(`<br><b${bStyle}>Outages</b><br>`);
    const oRows = filteredOutages.map((o) => [
      o.duid,
      o.region.replace("1", ""),
      o.type === "full" ? "outage" : `partial (${o.availableMW}/${o.maxCapacity}MW)`,
      o.expectedReturn ? fmtDate(o.expectedReturn) : "-",
    ]);
    parts.push(table(["Unit", "Region", "Status", "Return"], oRows));
  }

  // Upcoming table
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const filteredUpcoming = (market.upcomingOutages ?? []).filter((o) => {
    if (o.region.startsWith("SA") || o.region.startsWith("TAS")) return false;
    if (outageFuels && !outageFuels.has(o.fuel)) return false;
    const startMs = new Date(o.outageStart.replace(/\//g, "-")).getTime();
    return startMs - nowMs <= fourteenDaysMs;
  });
  if (filteredUpcoming.length > 0) {
    parts.push(`<br><b${bStyle}>Upcoming Outages</b><br>`);
    const uRows = filteredUpcoming.map((o) => [
      o.duid,
      o.region.replace("1", ""),
      fmtDate(o.outageStart),
      o.expectedReturn ? fmtDate(o.expectedReturn) : "-",
    ]);
    parts.push(table(["Unit", "Region", "From", "To"], uRows));
  }

  return parts.join("");
}

function MarketAnalysisTab() {
  const { data: rawData, isLoading } = useSWR<{ market: MarketSummaryData }>(
    "/api/analytics?tab=market",
    fetcher,
    { refreshInterval: 30_000 },
  );
  const marketRaw = rawData?.market ?? null;
  const market = marketRaw ? {
    ...marketRaw,
    outages: marketRaw.outages ?? [],
    upcomingOutages: marketRaw.upcomingOutages ?? [],
    interconnectors: marketRaw.interconnectors ?? [],
    regions: marketRaw.regions ?? [],
    temps: marketRaw.temps ?? {},
  } : null;

  const [manual, setManual] = useState<MarketManualData>(loadManualData);
  const [editingManual, setEditingManual] = useState(false);
  const [copied, setCopied] = useState(false);

  // Filter preferences persisted in localStorage
  const [outageFuels, setOutageFuels] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("nem-market-outage-fuels");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set(["Coal", "Gas"]);
  });
  const toggleOutageFuel = (fuel: string) => {
    setOutageFuels((prev) => {
      const next = new Set(prev);
      if (next.has(fuel)) next.delete(fuel);
      else next.add(fuel);
      localStorage.setItem("nem-market-outage-fuels", JSON.stringify([...next]));
      return next;
    });
  };

  const [textStyle, setTextStyle] = useState<MarketTextStyle>(() => {
    try {
      const saved = localStorage.getItem("nem-market-text-style");
      if (saved && ["compact", "dot-point", "narrative", "table"].includes(saved)) return saved as MarketTextStyle;
    } catch { /* ignore */ }
    return "compact";
  });
  const changeStyle = (s: MarketTextStyle) => {
    setTextStyle(s);
    localStorage.setItem("nem-market-text-style", s);
  };

  const IC_ALL = ["QNI", "Terranora", "VNI", "Heywood", "Murraylink"];
  const [icFilterSet, setIcFilterSet] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("nem-market-ic-filter");
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set(IC_ALL);
  });
  const toggleIC = (name: string) => {
    setIcFilterSet((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem("nem-market-ic-filter", JSON.stringify([...next]));
      return next;
    });
  };

  // Edit state drafts
  const [draftTemps, setDraftTemps] = useState<Record<string, string>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});

  const startEdit = () => {
    setDraftTemps({ ...manual.temps });
    setDraftNotes({ ...manual.notes });
    setEditingManual(true);
  };

  const saveEdit = () => {
    const next: MarketManualData = { date: getToday(), temps: draftTemps, notes: draftNotes };
    saveManualData(next);
    setManual(next);
    setEditingManual(false);
  };

  const handleCopy = async () => {
    if (!market) return;
    const text = buildMarketText(market, manual, outageFuels, icFilterSet, textStyle);
    const plainText = text.replace(/\*\*/g, "");

    let html: string;
    if (textStyle === "table") {
      html = buildMarketTableHtml(market, manual, outageFuels, icFilterSet);
    } else {
      html = text
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/\n/g, "<br>");
    }

    const blob = new Blob([html], { type: "text/html" });
    const plainBlob = new Blob([plainText], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": blob, "text/plain": plainBlob }),
    ]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const regionBg: Record<string, string> = {
    NSW: "bg-blue-500/10 border-blue-500/20",
    QLD: "bg-red-500/10 border-red-500/20",
    VIC: "bg-violet-500/10 border-violet-500/20",
    SA: "bg-amber-500/10 border-amber-500/20",
  };

  const regionText: Record<string, string> = {
    NSW: "text-blue-400", QLD: "text-red-400", VIC: "text-violet-400", SA: "text-amber-400",
  };

  if (isLoading || !market) {
    return <LoadingState />;
  }

  // --- Edit Manual Data (temps, notes) ---
  if (editingManual) {
    const regions = ["NSW", "QLD", "VIC", "SA"];
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Edit Temperatures & Notes</h2>
          <div className="flex gap-2">
            <button onClick={() => setEditingManual(false)} className="px-3 py-1.5 text-xs rounded-md font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors">Cancel</button>
            <button onClick={saveEdit} className="px-3 py-1.5 text-xs rounded-md font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors flex items-center gap-1.5">
              <Save className="h-3.5 w-3.5" /> Save
            </button>
          </div>
        </div>

        <Card className="rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Thermometer className="h-4 w-4 text-zinc-400" /> Temperatures & Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {regions.map((r) => (
              <div key={r} className={cn("rounded-lg border p-3 space-y-2", regionBg[r])}>
                <div className={cn("text-xs font-semibold", regionText[r])}>{r}</div>
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="Max temp (e.g. 26°C)" value={draftTemps[r] ?? ""} onChange={(e) => setDraftTemps((p) => ({ ...p, [r]: e.target.value }))}
                    className="bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500" />
                  <input placeholder="Notes (e.g. high cloud 89%)" value={draftNotes[r] ?? ""} onChange={(e) => setDraftNotes((p) => ({ ...p, [r]: e.target.value }))}
                    className="bg-white/[0.05] border border-white/[0.08] rounded px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  // --- Display Mode ---
  const summaryText = buildMarketText(market, manual, outageFuels, icFilterSet, textStyle);

  return (
    <div className="space-y-3">
      {/* Two-column layout: data left, copyable text right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-3 lg:items-stretch">
        {/* Left column: regions, interconnectors, outages, upcoming */}
        <div className="space-y-3">
          {/* Region cards */}
          <div className="grid grid-cols-2 gap-2">
            {market.regions.map((r) => (
              <div key={r.region} className={cn("rounded-lg border p-3 space-y-1.5", regionBg[r.region])}>
                <div className={cn("text-xs font-semibold", regionText[r.region])}>{r.region}</div>
                {(() => {
                  const regionKey = r.region.replace("1", "");
                  const manualTemp = manual.temps[r.region] || manual.temps[regionKey];
                  const apiTemp = market.temps?.[regionKey];
                  const tempDisplay = manualTemp || (apiTemp != null ? `${apiTemp}°C` : null);
                  return tempDisplay ? (
                    <div className="flex items-center gap-1.5">
                      <Thermometer className="h-3 w-3 text-orange-400 shrink-0" />
                      <span className="text-[11px] text-zinc-500 font-sans w-12">Temp</span>
                      <span className="text-[11px] text-zinc-300">Max {tempDisplay}</span>
                    </div>
                  ) : null;
                })()}
                {(r.windMW > 0 || r.windNowMW > 0) && (
                  <div className="flex items-center gap-1.5">
                    <Wind className="h-3 w-3 text-emerald-400 shrink-0" />
                    <span className="text-[11px] text-zinc-500 font-sans w-12">Wind</span>
                    <span className="text-[11px] text-zinc-300 font-mono tabular-nums">
                      {r.windNowMW.toLocaleString()}
                      <span className="text-zinc-500 font-sans text-[9px]"> now</span>
                      <span className="mx-1 text-zinc-600">,</span>
                      {r.windMW.toLocaleString()}
                      <span className="text-zinc-500 font-sans text-[9px]"> peak</span>
                      <span className="text-zinc-500 ml-0.5 font-sans">MW</span>
                    </span>
                  </div>
                )}
                {(r.solarMW > 0 || r.solarNowMW > 0) && (
                  <div className="flex items-center gap-1.5">
                    <Sun className="h-3 w-3 text-yellow-400 shrink-0" />
                    <span className="text-[11px] text-zinc-500 font-sans w-12">Solar</span>
                    <span className="text-[11px] text-zinc-300 font-mono tabular-nums">
                      {r.solarNowMW.toLocaleString()}
                      <span className="text-zinc-500 font-sans text-[9px]"> now</span>
                      <span className="mx-1 text-zinc-600">,</span>
                      {r.solarMW.toLocaleString()}
                      <span className="text-zinc-500 font-sans text-[9px]"> peak</span>
                      <span className="text-zinc-500 ml-0.5 font-sans">MW</span>
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-blue-400 shrink-0" />
                  <span className="text-[11px] text-zinc-500 font-sans w-12">Demand</span>
                  <span className="text-[11px] text-zinc-300 font-mono tabular-nums">
                    {r.peakDemand.toLocaleString()}
                    <span className="text-zinc-500 ml-0.5 font-sans">MW peak</span>
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-zinc-600 shrink-0" />
                  <span className="text-[11px] text-zinc-500 font-sans w-12">Demand</span>
                  <span className="text-[11px] text-zinc-400 font-mono tabular-nums">
                    {r.currentDemand.toLocaleString()}
                    <span className="text-zinc-500 ml-0.5 font-sans">MW now</span>
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Interconnectors */}
          {/* Interconnectors */}
          <div className="rounded-lg border bg-card p-2.5 space-y-5">
            <div className="text-xs font-medium flex items-center gap-1.5 text-zinc-300">
              <ArrowLeftRight className="h-3.5 w-3.5 text-zinc-400" /> Interconnectors
            </div>
            {market.interconnectors.length === 0 ? (
              <div className="text-[11px] text-zinc-500">No interconnectors at limits</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {market.interconnectors.map((ic) => (
                  <div key={ic.interconnectorId} className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1">
                    <span className="text-[11px] font-semibold text-cyan-400 font-mono">{ic.name}</span>
                    <span className="text-[10px] text-zinc-400">
                      {icDirectionLabel(ic.name, ic.direction)} {ic.bindingDescription || ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Outages */}
          <div className="rounded-lg border bg-card p-2.5 space-y-5">
            <div className="text-xs font-medium flex items-center gap-1.5 text-zinc-300">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Outages
            </div>
            {market.outages.length === 0 ? (
              <div className="text-[11px] text-zinc-500">No thermal outages detected</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {market.outages.map((o) => (
                  <div
                    key={o.duid}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1",
                      o.type === "full"
                        ? "border-rose-500/20 bg-rose-500/10"
                        : "border-amber-500/20 bg-amber-500/10",
                    )}
                  >
                    <span className={cn(
                      "text-[11px] font-bold font-mono",
                      o.type === "full" ? "text-rose-400" : "text-amber-400",
                    )}>{o.duid}</span>
                    <span className="text-[10px] text-zinc-400">
                      {o.type === "full" ? "out" : `${o.availableMW}/${o.maxCapacity}MW`}
                      {o.expectedReturn && (
                        <span className="text-zinc-500 ml-0.5">
                          till {new Date(o.expectedReturn).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" })}
                        </span>
                      )}
                      <span className="text-zinc-600 ml-0.5">{o.fuel}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Upcoming outages — within 30 days */}
          {(() => {
            const fourteenDays = 14 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const upcoming = (market.upcomingOutages ?? []).filter((o) => {
              const startMs = new Date(o.outageStart.replace(/\//g, "-")).getTime();
              return startMs - now <= fourteenDays;
            });
            return upcoming.length > 0 ? (
              <div className="rounded-lg border bg-card p-2.5 space-y-5">
                <div className="text-xs font-medium flex items-center gap-1.5 text-zinc-300">
                  <Clock className="h-3.5 w-3.5 text-zinc-400" /> Upcoming Outages
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {upcoming.map((o) => {
                    const startD = new Date(o.outageStart.replace(/\//g, "-"));
                    const startStr = startD.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" });
                    const endStr = o.expectedReturn
                      ? new Date(o.expectedReturn.replace(/\//g, "-")).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" })
                      : null;
                    return (
                      <div key={o.duid} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-500/20 bg-zinc-500/10 px-2.5 py-1">
                        <span className="text-[11px] font-bold font-mono text-zinc-300">{o.duid}</span>
                        <span className="text-[10px] text-zinc-400">
                          {startStr}{endStr ? ` → ${endStr}` : ""}
                          <span className="text-zinc-600 ml-0.5">{o.fuel} · {o.region.replace("1", "")}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null;
          })()}
        </div>

        {/* Right column: copyable text summary with filters */}
        <div className="relative rounded-lg border border-input bg-white/[0.03] p-3 pr-10 text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words leading-relaxed overflow-auto min-h-[300px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2 not-prose" style={{ fontFamily: "inherit" }}>
            <div className="flex items-center gap-1.5">
              <Filter className="h-3 w-3 text-zinc-500 shrink-0" />
              <span className="text-[10px] text-zinc-500 font-sans">Outages:</span>
              {["Coal", "Gas"].map((fuel) => (
                <button
                  key={fuel}
                  onClick={() => toggleOutageFuel(fuel)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-medium font-sans transition-colors",
                    outageFuels.has(fuel)
                      ? "bg-zinc-700 text-zinc-200"
                      : "bg-transparent text-zinc-600 border border-zinc-700/50",
                  )}
                >
                  {fuel}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-sans">ICs:</span>
              {IC_ALL.map((name) => (
                <button
                  key={name}
                  onClick={() => toggleIC(name)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-medium font-sans transition-colors",
                    icFilterSet.has(name)
                      ? "bg-zinc-700 text-zinc-200"
                      : "bg-transparent text-zinc-600 border border-zinc-700/50",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-500 font-sans">Style:</span>
              {([["compact", "Compact"], ["dot-point", "Dot Point"], ["narrative", "Narrative"], ["table", "Table"]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => changeStyle(key)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-medium font-sans transition-colors",
                    textStyle === key
                      ? "bg-zinc-700 text-zinc-200"
                      : "bg-transparent text-zinc-600 border border-zinc-700/50",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" onClick={handleCopy}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </Button>
          {textStyle === "table" ? (
            <div
              className="market-table-preview"
              dangerouslySetInnerHTML={{ __html: buildMarketTableHtml(market, manual, outageFuels, icFilterSet, true) }}
            />
          ) : (
            summaryText.split("\n").map((line, i) => {
              const parts = line.split(/(\*\*.*?\*\*)/g);
              return (
                <span key={i}>
                  {parts.map((part, j) =>
                    part.startsWith("**") && part.endsWith("**")
                      ? <strong key={j} className="text-zinc-100 font-semibold">{part.slice(2, -2)}</strong>
                      : part
                  )}
                  {"\n"}
                </span>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
