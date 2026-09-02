export type DashRange = "month" | "quarter" | "year" | "all";

export const DASH_RANGES: DashRange[] = ["month", "quarter", "year", "all"];

export function isDashRange(value: string | null | undefined): value is DashRange {
  return value === "month" || value === "quarter" || value === "year" || value === "all";
}

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Calendar bounds for a dashboard range as `YYYY-MM-DD` strings.
 * `all` (or an unknown value) yields empty strings — i.e. no date filter.
 */
export function dashRangeToYmd(range: string | null | undefined): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();

  if (range === "month") {
    return {
      from: ymd(new Date(y, now.getMonth(), 1)),
      to: ymd(new Date(y, now.getMonth() + 1, 0)),
    };
  }
  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    return { from: ymd(new Date(y, q * 3, 1)), to: ymd(new Date(y, q * 3 + 3, 0)) };
  }
  if (range === "year") {
    return { from: ymd(new Date(y, 0, 1)), to: ymd(new Date(y, 11, 31)) };
  }
  return { from: "", to: "" };
}

export function dashRangeLabel(range: string | null | undefined): string {
  if (range === "month") return "This month";
  if (range === "quarter") return "This quarter";
  if (range === "year") return "This year";
  return "All time";
}
