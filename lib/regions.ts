export const REGIONS = [
  { id: "NSW1", name: "New South Wales", color: "#3b82f6", tremorColor: "blue", short: "NSW" },
  { id: "QLD1", name: "Queensland", color: "#ef4444", tremorColor: "red", short: "QLD" },
  { id: "VIC1", name: "Victoria", color: "#a855f7", tremorColor: "violet", short: "VIC" },
  { id: "SA1", name: "South Australia", color: "#f59e0b", tremorColor: "amber", short: "SA" },
] as const;

export type RegionId = (typeof REGIONS)[number]["id"];

export const REGION_MAP = Object.fromEntries(
  REGIONS.map((r) => [r.id, r]),
) as Record<RegionId, (typeof REGIONS)[number]>;

export const REGION_COLORS: Record<string, string> = Object.fromEntries(
  REGIONS.map((r) => [r.id, r.color]),
);

export const REGION_TREMOR_COLORS: Record<string, string> = Object.fromEntries(
  REGIONS.map((r) => [r.id, r.tremorColor]),
);

/**
 * NEM Interconnector definitions.
 * Positive METEREDMWFLOW = power flows from `from` → `to`.
 * Negative = reverse direction.
 */
export const INTERCONNECTORS: Record<string, { name: string; from: string; to: string }> = {
  "NSW1-QLD1":  { name: "QNI",          from: "NSW", to: "QLD" },
  "N-Q-MNSP1":  { name: "Terranora",    from: "NSW", to: "QLD" },
  "VIC1-NSW1":  { name: "VIC–NSW",      from: "VIC", to: "NSW" },
  "V-SA":       { name: "Heywood",      from: "VIC", to: "SA"  },
  "V-S-MNSP1":  { name: "Murraylink",   from: "VIC", to: "SA"  },
};

/** Get human-readable direction label for an interconnector flow */
export function getFlowDirection(interconnectorId: string, flow: number): string {
  const ic = INTERCONNECTORS[interconnectorId];
  if (!ic) return flow >= 0 ? "→" : "←";
  return flow >= 0 ? `${ic.from} → ${ic.to}` : `${ic.to} → ${ic.from}`;
}

/** Get the friendly name for an interconnector, falling back to its ID */
export function getInterconnectorName(interconnectorId: string): string {
  return INTERCONNECTORS[interconnectorId]?.name ?? interconnectorId;
}
