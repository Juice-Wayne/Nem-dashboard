"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  DollarSign,
  TrendingUp,
  ArrowLeftRight,
  SlidersHorizontal,
  Target,
  Zap,
  AlertTriangle,
  Flag,
  Flame,
  Factory,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NavTabId =
  | "prices"
  | "demand"
  | "interconnectors"
  | "sensitivities"
  | "actuals"
  | "market-nem"
  | "spikes"
  | "startcost"
  | "offloading"
  | "braemar"
  | "bdl";

interface NavItem {
  id: NavTabId;
  label: string;
  icon?: LucideIcon;
  /** Single-letter mark used in place of an icon (e.g. "N", "W"). */
  letter?: string;
}

interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    id: "rebids",
    label: "Rebids",
    items: [
      { id: "prices", label: "Prices", icon: DollarSign },
      { id: "demand", label: "Demand", icon: TrendingUp },
      { id: "interconnectors", label: "Interconnectors", icon: ArrowLeftRight },
      { id: "sensitivities", label: "Sensitivities", icon: SlidersHorizontal },
      { id: "actuals", label: "Actuals vs 5PD", icon: Target },
    ],
  },
  {
    id: "market",
    label: "Market",
    items: [
      { id: "market-nem", label: "NEM Market Summary", letter: "N" },
      { id: "spikes", label: "Spikes", icon: AlertTriangle },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      { id: "startcost", label: "Braemar Start", icon: Flag },
      { id: "offloading", label: "Coal Offloading", icon: Flame },
      { id: "braemar", label: "Braemar Revenue", icon: Factory },
      { id: "bdl", label: "BDL Revenue", icon: Factory },
    ],
  },
];

const COLLAPSED_W = 56;
const EXPANDED_W = 220;
const HOVER_DELAY_MS = 150;

/** Export so the page can reserve matching left margin. */
export const SIDE_NAV_COLLAPSED_WIDTH = COLLAPSED_W;

export function SideNav({
  activeTab,
  onTabChange,
}: {
  activeTab: NavTabId;
  onTabChange: (id: NavTabId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onEnter = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setExpanded(true), HOVER_DELAY_MS);
  };
  const onLeave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setExpanded(false);
  };

  return (
    <nav
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ width: expanded ? EXPANDED_W : COLLAPSED_W }}
      className={cn(
        // Fixed so expansion overlays the main content instead of pushing it.
        "fixed left-0 top-0 h-screen z-30",
        "bg-zinc-950/95 backdrop-blur border-r border-white/[0.05]",
        "transition-[width] duration-200 ease-out overflow-hidden",
        // A subtle shadow when expanded to separate it from the content below.
        expanded && "shadow-2xl shadow-black/40",
      )}
      aria-label="Primary navigation"
    >
      <div className="flex flex-col h-full py-3">
        {/* Brand */}
        <div className="px-3 mb-4 flex items-center h-9">
          <div className="w-8 h-8 flex items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400 shrink-0">
            <Zap className="h-4 w-4" />
          </div>
          <span
            className={cn(
              "ml-3 text-sm font-semibold text-zinc-100 whitespace-nowrap",
              "transition-opacity duration-150",
              expanded ? "opacity-100" : "opacity-0",
            )}
          >
            Trader Tools
          </span>
        </div>

        <div className="flex-1 flex flex-col gap-4 overflow-y-auto overflow-x-hidden">
          {SECTIONS.map((section) => (
            <div key={section.id} className="flex flex-col">
              <div
                className={cn(
                  "px-4 mb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 whitespace-nowrap",
                  "transition-opacity duration-150",
                  expanded ? "opacity-100" : "opacity-0",
                )}
              >
                {section.label}
              </div>
              <div className="flex flex-col gap-0.5 px-2">
                {section.items.map((item) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    active={activeTab === item.id}
                    expanded={expanded}
                    onClick={() => onTabChange(item.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}

function NavButton({
  item,
  active,
  expanded,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      title={!expanded ? item.label : undefined}
      className={cn(
        "group relative flex items-center h-9 rounded-md px-2.5 transition-colors",
        active
          ? "bg-white/[0.08] text-zinc-100"
          : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-emerald-400 rounded-full" />
      )}
      {item.letter ? (
        <span
          className={cn(
            "inline-flex items-center justify-center h-4 w-4 shrink-0 text-[10px] font-bold leading-none rounded-sm border",
            active
              ? "text-emerald-400 border-emerald-400/60"
              : "border-zinc-600/60",
          )}
        >
          {item.letter}
        </span>
      ) : Icon ? (
        <Icon className={cn("h-4 w-4 shrink-0", active && "text-emerald-400")} />
      ) : null}
      <span
        className={cn(
          "ml-3 text-xs font-medium whitespace-nowrap",
          "transition-opacity duration-150",
          expanded ? "opacity-100" : "opacity-0",
        )}
      >
        {item.label}
      </span>
    </button>
  );
}
