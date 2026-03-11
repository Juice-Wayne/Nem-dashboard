"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoRefresh } from "@/lib/hooks/use-auto-refresh";
import { NemIntervalBar } from "@/components/nem-interval-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type TabId = "prices" | "demand" | "interconnectors" | "sensitivities" | "actuals";

// --- Helpers ---

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

// --- Page ---

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<TabId>("prices");
  const [region, setRegion] = useState<string>("QLD1");
  const [interconnector, setInterconnector] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [copiedReason, setCopiedReason] = useState(false);
  const [selectedRow, setSelectedRow] = useState<SelectedRow | null>(null);

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
  const showRegionSelector = activeTab !== "interconnectors";
  const showInterconnectorSelector = activeTab === "interconnectors";


  return (
    <div className="space-y-6">
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
            </TabsList>
            <button
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              title={
                lastRefreshedAt
                  ? `Last updated: ${lastRefreshedAt.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Australia/Brisbane" })} AEST`
                  : "Refresh data"
              }
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded-lg transition-all duration-150",
                "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]",
                isRefreshing && "animate-spin text-zinc-400",
              )}
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          {/* NEM Interval countdown + current prices — absolutely centered */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto z-10 hidden lg:block">
            <NemIntervalBar
              regionPrices={regionPrices}
              lastRefreshedAt={lastRefreshedAt}
            />
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2">
            {showRegionSelector && (
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
            {showInterconnectorSelector && (
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
            {activeTab !== "actuals" && (
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
            {selectedRow && (
              <button
                onClick={clearSelection}
                className="px-2 py-1 text-xs rounded-md font-medium text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Rebid Reason Generator */}
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
                        <TableRow key={`${tk}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
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
                        <TableRow key={`${tk}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
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
                        <TableRow key={`${tk}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
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
                        <TableRow key={`${tk}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
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
                      <TableHead className="text-right">Prev Flow</TableHead>
                      <TableHead className="text-right">Curr Flow</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered5pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "5PD" && selectedRow?.timeKey === tk && selectedRow?.label === getInterconnectorName(row.INTERCONNECTORID);
                      return (
                        <TableRow key={`${tk}-${row.INTERCONNECTORID}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-emerald-500/10" : ""}`} onClick={() => handleSelect("5PD", row)}>
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
                      <TableHead className="text-right">Prev Flow</TableHead>
                      <TableHead className="text-right">Curr Flow</TableHead>
                      <TableHead className="text-right">Delta</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered30pd.map((row, idx) => {
                      const tk = getTimeKey(row);
                      const sel = selectedRow?.source === "30PD" && selectedRow?.timeKey === tk && selectedRow?.label === getInterconnectorName(row.INTERCONNECTORID);
                      return (
                        <TableRow key={`${tk}-${row.INTERCONNECTORID}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
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
    const byRegion = data.p5min.filter((r) => r.REGIONID === region);
    return sortByTime(filterByDirection(byRegion, direction));
  }, [data, region, direction]);

  const filtered30pd = useMemo(() => {
    if (!data?.predispatch) return [];
    const byRegion = data.predispatch.filter((r) => r.REGIONID === region);
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
            <CardTitle className="text-base">30-Min PD Sensitivities — {regionLabel}</CardTitle>
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
                        <TableRow key={`${tk}-${row.SCENARIO}-${idx}`} className={`cursor-pointer transition-colors ${sel ? "bg-blue-500/10" : ""}`} onClick={() => handleSelect("30PD", row)}>
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
            ) : <EmptyState label={`No 30PD sensitivity ${direction !== "all" ? `${direction}s` : "changes"} for ${regionLabel}`} />
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
    <div className="space-y-6 mt-4">
      {/* Prices: Forecast vs Actual */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Prices — 5PD Forecast vs Actual — {regionLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          {data ? (
            filteredPrices.length > 0 ? (
              <div className="max-h-[400px] overflow-auto">
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
              <div className="max-h-[400px] overflow-auto">
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
              <div className="max-h-[400px] overflow-auto">
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
