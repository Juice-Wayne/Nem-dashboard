"use client";

import React, { useMemo, useState } from "react";
import useSWR from "swr";
import { ChevronLeft, ChevronRight, ChevronDown, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Plant definitions — must match app/api/revenue/route.ts
const PLANTS = {
  braemar: { duids: ["BRAEMAR1", "BRAEMAR2", "BRAEMAR3"], region: "QLD1", label: "Braemar" },
  bdl: { duids: ["BDL01", "BDL02"], region: "VIC1", label: "BDL" },
} as const;

export type PlantKey = keyof typeof PLANTS;

// Lookback extends to Jan 2025 (Q1 2025 backfilled from NeoPoint, rest from AEMO archive).
const LOOKBACK_START_YEAR = 2025;
const LOOKBACK_START_MONTH = 1;

interface DayUnitAgg {
  mwh: number;
  runIntervals: number;
  runRrpWeighted: number;
  runMwTotal: number;
  revenue: number;
}

interface MonthResponse {
  plant: PlantKey;
  duids: string[];
  region: string;
  month: string;
  days: Array<{ date: string; units: Record<string, DayUnitAgg> }>;
}

interface DayResponse {
  plant: PlantKey;
  duids: string[];
  region: string;
  date: string;
  units: Record<string, DayUnitAgg>;
  intervals: Array<{ t: string; rrp: number; units: Record<string, number> }>;
}

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
});

// --- Formatting helpers --------------------------------------------------

// Small SCADA aux-load blips (few W to a couple of MWh over a day) get rounded away so
// the table doesn't show -0.0 / -$1 for units that were never actually running.
const MWH_EPSILON = 0.5;
const REV_EPSILON = 1;

function fmtMWh(v: number): string {
  if (Math.abs(v) < MWH_EPSILON) return "0";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} GWh`;
  return `${v.toFixed(1)}`;
}

function fmtPrice(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toFixed(0)}`;
}

function fmtRevenue(v: number): string {
  if (Math.abs(v) < REV_EPSILON) return "$0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) return `${v < 0 ? "-" : ""}$${(abs / 1000).toFixed(1)}k`;
  return `${v < 0 ? "-" : ""}$${Math.round(abs)}`;
}

function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" });
  return `${dow} ${String(d).padStart(2, "0")}`;
}

function avgRunPrice(u: DayUnitAgg): number | null {
  if (u.runMwTotal <= 0) return null;
  return u.runRrpWeighted / u.runMwTotal;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCurrentMonthIso(monthIso: string): boolean {
  return monthIso === todayIso().slice(0, 7);
}

function monthsUpToCurrent(): string[] {
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  const out: string[] = [];
  for (let y = LOOKBACK_START_YEAR; y <= curY; y++) {
    const startM = y === LOOKBACK_START_YEAR ? LOOKBACK_START_MONTH : 1;
    const endM = y === curY ? curM : 12;
    for (let m = startM; m <= endM; m++) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
    }
  }
  return out;
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function groupMonthsByYear(months: string[]): Array<{ year: string; months: string[] }> {
  const groups: Array<{ year: string; months: string[] }> = [];
  for (const m of months) {
    const y = m.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last && last.year === y) last.months.push(m);
    else groups.push({ year: y, months: [m] });
  }
  return groups;
}

function shiftMonth(iso: string, delta: number): string | null {
  const months = monthsUpToCurrent();
  const idx = months.indexOf(iso);
  if (idx < 0) return null;
  const target = idx + delta;
  if (target < 0 || target >= months.length) return null;
  return months[target];
}

// --- Sorting -------------------------------------------------------------

type SortKey = "date" | "total-mwh" | "total-rev" | `unit-rev-${string}` | `unit-mwh-${string}` | `unit-price-${string}`;

interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

function rowTotals(row: { units: Record<string, DayUnitAgg> }, duids: readonly string[]) {
  let mwh = 0, revenue = 0, runMw = 0, runRrp = 0;
  for (const d of duids) {
    const u = row.units[d];
    if (!u) continue;
    mwh += u.mwh;
    revenue += u.revenue;
    runMw += u.runMwTotal;
    runRrp += u.runRrpWeighted;
  }
  return { mwh, revenue, avgPrice: runMw > 0 ? runRrp / runMw : null };
}

// --- Day drill-down ------------------------------------------------------

function DayDrilldown({ plant, date, duids }: { plant: PlantKey; date: string; duids: readonly string[] }) {
  const { data, isLoading, error } = useSWR<DayResponse>(
    `/api/revenue?plant=${plant}&day=${date}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 5 * 60_000 },
  );

  if (isLoading) return <div className="text-xs text-zinc-500 px-4 py-3">Loading 5-min detail…</div>;
  if (error || !data) return <div className="text-xs text-rose-400 px-4 py-3">Failed to load day detail.</div>;

  // Only show intervals where at least one of our units ran, to keep the table readable.
  const rows = data.intervals.filter((i) => duids.some((d) => (i.units[d] ?? 0) > 0));
  if (rows.length === 0) {
    return <div className="text-xs text-zinc-500 px-4 py-3">No generation recorded on this day.</div>;
  }

  return (
    <div className="bg-white/[0.015] border-t border-white/[0.04]">
      <div className="max-h-[360px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-zinc-900/95 backdrop-blur">
            <TableRow>
              <TableHead className="w-24">Time</TableHead>
              <TableHead className="text-right w-20">RRP</TableHead>
              {duids.map((d) => (
                <TableHead key={d} className="text-right">{d}</TableHead>
              ))}
              <TableHead className="text-right w-24">Interval $</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const intervalRevenue = duids.reduce((acc, d) => acc + (r.units[d] ?? 0) * r.rrp * (5 / 60), 0);
              const hhmm = r.t.slice(11, 16);
              return (
                <TableRow key={r.t} className="text-xs">
                  <TableCell className="font-mono">{hhmm}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtPrice(r.rrp)}</TableCell>
                  {duids.map((d) => (
                    <TableCell key={d} className="text-right font-mono tabular-nums">
                      {(r.units[d] ?? 0).toFixed(1)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right font-mono tabular-nums">{fmtRevenue(intervalRevenue)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- Sortable header cell ------------------------------------------------

function SortHead({
  children,
  sortKey,
  sort,
  onSort,
  align = "left",
  className,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn(
        "cursor-pointer select-none hover:text-zinc-200 transition-colors",
        align === "right" && "text-right",
        active && "text-zinc-200",
        className,
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end")}>
        {children}
        <Icon className="h-3 w-3 opacity-60" />
      </span>
    </TableHead>
  );
}

// --- Main component ------------------------------------------------------

export function RevenueTab({ plant }: { plant: PlantKey }) {
  const { duids, region } = PLANTS[plant];
  const months = useMemo(() => monthsUpToCurrent(), []);
  const [month, setMonth] = useState<string>(() => months[months.length - 1]);
  const [sort, setSort] = useState<Sort>({ key: "date", dir: "asc" });
  const [openDay, setOpenDay] = useState<string | null>(null);

  const { data, isLoading, error } = useSWR<MonthResponse>(
    `/api/revenue?plant=${plant}&month=${month}`,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 2 * 60_000 },
  );

  // Only show days where at least one unit actually generated.
  const days = (data?.days ?? []).filter((d) =>
    duids.some((u) => (d.units[u]?.mwh ?? 0) > MWH_EPSILON),
  );

  const monthTotals = useMemo(() => {
    const totals: Record<string, DayUnitAgg> = {};
    for (const d of duids) {
      totals[d] = { mwh: 0, runIntervals: 0, runRrpWeighted: 0, runMwTotal: 0, revenue: 0 };
    }
    for (const row of days) {
      for (const d of duids) {
        const u = row.units[d];
        if (!u) continue;
        totals[d].mwh += u.mwh;
        totals[d].runIntervals += u.runIntervals;
        totals[d].runRrpWeighted += u.runRrpWeighted;
        totals[d].runMwTotal += u.runMwTotal;
        totals[d].revenue += u.revenue;
      }
    }
    return totals;
  }, [days, duids]);

  const plantTotals = useMemo(() => rowTotals({ units: monthTotals }, duids), [monthTotals, duids]);

  const sortedDays = useMemo(() => {
    const sign = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: typeof days[number], b: typeof days[number]): number => {
      if (sort.key === "date") return sign * a.date.localeCompare(b.date);
      if (sort.key === "total-mwh") return sign * (rowTotals(a, duids).mwh - rowTotals(b, duids).mwh);
      if (sort.key === "total-rev") return sign * (rowTotals(a, duids).revenue - rowTotals(b, duids).revenue);
      const [, kind, duid] = sort.key.split("-", 3) as [string, "mwh" | "rev" | "price", string];
      const ua = a.units[duid];
      const ub = b.units[duid];
      if (kind === "mwh") return sign * ((ua?.mwh ?? 0) - (ub?.mwh ?? 0));
      if (kind === "rev") return sign * ((ua?.revenue ?? 0) - (ub?.revenue ?? 0));
      const pa = ua ? (avgRunPrice(ua) ?? -Infinity) : -Infinity;
      const pb = ub ? (avgRunPrice(ub) ?? -Infinity) : -Infinity;
      return sign * (pa - pb);
    };
    return [...days].sort(cmp);
  }, [days, sort, duids]);

  const onSort = (key: SortKey) => {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  };

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const plantLabel = PLANTS[plant].label;

  return (
    <div className="space-y-4">
      {/* Header: month nav + plant summary + export */}
      <Card className="rounded-xl">
        <CardContent className="py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" disabled={!prev} onClick={() => prev && setMonth(prev)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="text-sm font-semibold min-w-[8rem] text-center">{monthLabel(month)}</div>
            <Button variant="ghost" size="icon-sm" disabled={!next} onClick={() => next && setMonth(next)}>
              <ChevronRight className="h-4 w-4" />
            </Button>

            <div className="ml-3 flex flex-wrap items-center gap-3">
              {groupMonthsByYear(months).map((group) => (
                <div key={group.year} className="flex items-center gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mr-0.5">
                    {group.year}
                  </span>
                  {group.months.map((m) => (
                    <button
                      key={m}
                      onClick={() => setMonth(m)}
                      className={cn(
                        "px-2 py-1 text-xs rounded-md transition-colors",
                        m === month
                          ? "bg-white/[0.08] text-zinc-100 font-semibold"
                          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]",
                      )}
                    >
                      {monthLabel(m).split(" ")[0]}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <div>
              <span className="text-zinc-500">Plant:</span>{" "}
              <span className="font-semibold">{plantLabel}</span>{" "}
              <span className="text-zinc-500">({region})</span>
            </div>
            <div>
              <span className="text-zinc-500">MWh:</span>{" "}
              <span className="font-mono tabular-nums">{fmtMWh(plantTotals.mwh)}</span>
            </div>
            <div>
              <span className="text-zinc-500">Avg run $:</span>{" "}
              <span className="font-mono tabular-nums">{fmtPrice(plantTotals.avgPrice)}</span>
            </div>
            <div>
              <span className="text-zinc-500">Revenue:</span>{" "}
              <span className="font-mono tabular-nums font-semibold text-emerald-400">{fmtRevenue(plantTotals.revenue)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading / error / table */}
      {isLoading && days.length === 0 && (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-zinc-500">
            {isCurrentMonthIso(month)
              ? `Loading ${monthLabel(month)} — current month is aggregated live from AEMO, this can take up to ~30s.`
              : `Loading ${monthLabel(month)}…`}
          </CardContent>
        </Card>
      )}
      {error && (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-rose-400">
            Failed to load data: {String(error)}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && days.length === 0 && (
        <Card className="rounded-xl">
          <CardContent className="py-8 text-center text-sm text-zinc-500">
            No generation recorded for {PLANTS[plant].label} in {monthLabel(month)}.
          </CardContent>
        </Card>
      )}

      {days.length > 0 && (
        <Card className="rounded-xl overflow-hidden">
          <Table>
            <TableHeader>
              {/* Row 1 — group labels: Day | Unit name (spans 3) | ... | Total (spans 2) */}
              <TableRow className="border-b-0 hover:bg-transparent">
                <TableHead rowSpan={2} className="align-bottom">
                  <button
                    onClick={() => onSort("date")}
                    className={cn("inline-flex items-center gap-1 hover:text-zinc-200", sort.key === "date" && "text-zinc-200")}
                  >
                    Day
                    {sort.key === "date"
                      ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                      : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                  </button>
                </TableHead>
                {duids.map((d, idx) => (
                  <TableHead
                    key={d}
                    colSpan={3}
                    className={cn(
                      "text-center font-semibold uppercase tracking-wide text-[11px] border-b border-white/[0.05]",
                      idx % 2 === 0 ? "bg-white/[0.015]" : "bg-white/[0.03]",
                      "border-l border-white/[0.06]",
                    )}
                  >
                    {d}
                  </TableHead>
                ))}
                <TableHead colSpan={2} className="text-center font-semibold uppercase tracking-wide text-[11px] border-b border-white/[0.05] border-l border-white/[0.08] bg-emerald-950/30">
                  Plant Total
                </TableHead>
              </TableRow>
              {/* Row 2 — sub-labels */}
              <TableRow>
                {duids.map((d, idx) => {
                  const groupBg = idx % 2 === 0 ? "bg-white/[0.015]" : "bg-white/[0.03]";
                  return (
                    <React.Fragment key={d}>
                      <TableHead className={cn("text-right text-[11px] border-l border-white/[0.06]", groupBg)}>
                        <button
                          onClick={() => onSort(`unit-mwh-${d}` as SortKey)}
                          className={cn("inline-flex items-center gap-1 justify-end w-full hover:text-zinc-200", sort.key === `unit-mwh-${d}` && "text-zinc-200")}
                        >
                          MWh
                          {sort.key === `unit-mwh-${d}`
                            ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                            : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                        </button>
                      </TableHead>
                      <TableHead className={cn("text-right text-[11px]", groupBg)}>
                        <button
                          onClick={() => onSort(`unit-price-${d}` as SortKey)}
                          className={cn("inline-flex items-center gap-1 justify-end w-full hover:text-zinc-200", sort.key === `unit-price-${d}` && "text-zinc-200")}
                        >
                          $/MWh
                          {sort.key === `unit-price-${d}`
                            ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                            : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                        </button>
                      </TableHead>
                      <TableHead className={cn("text-right text-[11px]", groupBg)}>
                        <button
                          onClick={() => onSort(`unit-rev-${d}` as SortKey)}
                          className={cn("inline-flex items-center gap-1 justify-end w-full hover:text-zinc-200", sort.key === `unit-rev-${d}` && "text-zinc-200")}
                        >
                          Revenue
                          {sort.key === `unit-rev-${d}`
                            ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                            : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                        </button>
                      </TableHead>
                    </React.Fragment>
                  );
                })}
                <TableHead className="text-right text-[11px] border-l border-white/[0.08] bg-emerald-950/30">
                  <button
                    onClick={() => onSort("total-mwh")}
                    className={cn("inline-flex items-center gap-1 justify-end w-full hover:text-zinc-200", sort.key === "total-mwh" && "text-zinc-200")}
                  >
                    MWh
                    {sort.key === "total-mwh"
                      ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                      : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                  </button>
                </TableHead>
                <TableHead className="text-right text-[11px] bg-emerald-950/30">
                  <button
                    onClick={() => onSort("total-rev")}
                    className={cn("inline-flex items-center gap-1 justify-end w-full hover:text-zinc-200", sort.key === "total-rev" && "text-zinc-200")}
                  >
                    Revenue
                    {sort.key === "total-rev"
                      ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3 opacity-60" /> : <ArrowDown className="h-3 w-3 opacity-60" />)
                      : <ArrowUpDown className="h-3 w-3 opacity-60" />}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedDays.map((row, rowIdx) => {
                const totals = rowTotals(row, duids);
                const isOpen = openDay === row.date;
                const isFuture = row.date > todayIso();
                const altRow = rowIdx % 2 === 1;
                return (
                  <React.Fragment key={row.date}>
                    <TableRow
                      className={cn(
                        "cursor-pointer text-xs border-b border-white/[0.03]",
                        altRow && "bg-white/[0.01]",
                        isOpen && "bg-white/[0.05]",
                      )}
                      onClick={() => setOpenDay(isOpen ? null : row.date)}
                    >
                      <TableCell className="font-mono font-medium">
                        <span className="inline-flex items-center gap-1">
                          <ChevronDown className={cn("h-3 w-3 transition-transform text-zinc-500", !isOpen && "-rotate-90")} />
                          {fmtDayLabel(row.date)}
                        </span>
                      </TableCell>
                      {duids.map((d, idx) => {
                        const u = row.units[d];
                        const mwh = u?.mwh ?? 0;
                        const avg = u ? avgRunPrice(u) : null;
                        const rev = u?.revenue ?? 0;
                        const ran = mwh > MWH_EPSILON;
                        const groupBg = idx % 2 === 0 ? "bg-white/[0.01]" : "bg-white/[0.025]";
                        return (
                          <React.Fragment key={d}>
                            <TableCell className={cn("text-right font-mono tabular-nums border-l border-white/[0.04]", ran ? groupBg : cn(groupBg, "text-zinc-600"))}>
                              {ran ? mwh.toFixed(0) : "—"}
                            </TableCell>
                            <TableCell className={cn("text-right font-mono tabular-nums", ran ? groupBg : cn(groupBg, "text-zinc-600"))}>
                              {ran ? fmtPrice(avg) : "—"}
                            </TableCell>
                            <TableCell className={cn("text-right font-mono tabular-nums", groupBg, ran && rev > REV_EPSILON && "text-emerald-400/90", !ran && "text-zinc-600")}>
                              {ran ? fmtRevenue(rev) : "—"}
                            </TableCell>
                          </React.Fragment>
                        );
                      })}
                      <TableCell className="text-right font-mono tabular-nums border-l border-white/[0.08] bg-emerald-950/20 font-medium">
                        {fmtMWh(totals.mwh)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono tabular-nums bg-emerald-950/20 font-semibold", totals.revenue > REV_EPSILON && "text-emerald-400")}>
                        {fmtRevenue(totals.revenue)}
                      </TableCell>
                    </TableRow>
                    {isOpen && !isFuture && (
                      <TableRow>
                        <TableCell colSpan={2 + duids.length * 3 + 2} className="p-0">
                          <DayDrilldown plant={plant} date={row.date} duids={duids} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
              {/* Month totals row — bolder, top border, tinted */}
              <TableRow className="bg-white/[0.06] font-semibold text-xs border-t-2 border-white/[0.1]">
                <TableCell className="uppercase text-[11px] tracking-wider text-zinc-400">Month</TableCell>
                {duids.map((d, idx) => {
                  const u = monthTotals[d];
                  const avg = avgRunPrice(u);
                  const ran = u.mwh > MWH_EPSILON;
                  const groupBg = idx % 2 === 0 ? "bg-white/[0.015]" : "bg-white/[0.03]";
                  return (
                    <React.Fragment key={d}>
                      <TableCell className={cn("text-right font-mono tabular-nums border-l border-white/[0.06]", groupBg, !ran && "text-zinc-600")}>
                        {ran ? fmtMWh(u.mwh) : "—"}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono tabular-nums", groupBg, !ran && "text-zinc-600")}>
                        {ran ? fmtPrice(avg) : "—"}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono tabular-nums", groupBg, ran && u.revenue > REV_EPSILON ? "text-emerald-400" : "text-zinc-600")}>
                        {ran ? fmtRevenue(u.revenue) : "—"}
                      </TableCell>
                    </React.Fragment>
                  );
                })}
                <TableCell className="text-right font-mono tabular-nums border-l border-white/[0.08] bg-emerald-950/40">
                  {fmtMWh(plantTotals.mwh)}
                </TableCell>
                <TableCell className={cn("text-right font-mono tabular-nums bg-emerald-950/40", plantTotals.revenue > REV_EPSILON && "text-emerald-400")}>
                  {fmtRevenue(plantTotals.revenue)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
