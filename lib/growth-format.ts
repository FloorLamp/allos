// Pure display helpers for growth percentiles (no DB, no React) — unit-tested in
// lib/__tests__/growth-format.test.ts.

// Format a 0–100 percentile as an ordinal for display ("40th", "3rd", "97th").
// Rounds to the nearest whole percentile and clamps the extremes to "<1st"/">99th"
// so a z-score deep in the tail never renders as "0th" or "100th".
export function ordinalPercentile(percentile: number): string {
  if (percentile < 1) return "<1st";
  if (percentile > 99) return ">99th";
  const n = Math.round(percentile);
  return `${n}${ordinalSuffix(n)}`;
}

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
