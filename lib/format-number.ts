const countFormatter = new Intl.NumberFormat("en-US");
const listFormatter = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

// Fixed-English grouping; callers retain their domain's rounding and units.
export function formatCount(value: number): string {
  return countFormatter.format(value);
}

export function formatList(items: readonly string[]): string {
  return listFormatter.format(items);
}
