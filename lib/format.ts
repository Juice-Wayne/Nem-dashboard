export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

export function formatMW(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${Math.round(value).toLocaleString()} MW`;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatMWDelta(value: number | null | undefined): string {
  if (value == null) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Math.round(value).toLocaleString()} MW`;
}

export function priceColor(price: number): string {
  if (price < 0) return "text-blue-400";
  if (price < 50) return "text-emerald-400";
  if (price < 100) return "text-yellow-400";
  if (price < 300) return "text-orange-400";
  return "text-rose-400";
}
