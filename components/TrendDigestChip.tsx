import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import type { TrendItem } from "@/lib/trends-digest";

export type TrendDigestTone = "bad" | "warn" | "positive" | "neutral";

export function trendDigestTone(item: TrendItem): TrendDigestTone {
  if (item.rangeShift === "out-of-range") {
    return item.storedFlagTone === "warn" ? "warn" : "bad";
  }
  if (item.rangeShift === "into-range") return "positive";
  return "neutral";
}

const TONE_CLASS: Record<TrendDigestTone, string> = {
  bad: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300",
  warn: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  positive:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
  neutral:
    "border-slate-200 bg-surface text-slate-700 dark:border-white/10 dark:text-slate-200",
};

// The compact visual boundary for one admitted digest item. The domain decision
// (including the stored clinical flag's canonical tone) arrives on TrendItem;
// this component only maps it to the chip vocabulary and omits an arrow when a
// stored verdict changed without a numeric direction.
export default function TrendDigestChip({ item }: { item: TrendItem }) {
  const tone = trendDigestTone(item);
  const Arrow =
    item.direction === "up"
      ? IconArrowUpRight
      : item.direction === "down"
        ? IconArrowDownRight
        : null;

  return (
    <span
      data-testid="trend-digest-chip"
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${TONE_CLASS[tone]}`}
    >
      {Arrow ? <Arrow className="h-3.5 w-3.5 shrink-0" stroke={2} /> : null}
      {item.text}
    </span>
  );
}
