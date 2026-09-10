import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import type { TrendItem } from "@/lib/trends-digest";
import { verdictBadge, type VerdictTone } from "@/lib/chart-colors";

// The chip's vocabulary WAS the four verdict words with `positive` for `good`
// (#5187), so it is now the shared VerdictTone and the chip is the shared
// `.badge` pill: same shape, same tint steps, one border rule instead of a
// per-tone `border-*-200` this map maintained by hand.
export function trendDigestTone(item: TrendItem): VerdictTone {
  if (item.rangeShift === "out-of-range") {
    return item.storedFlagTone === "warn" ? "warn" : "bad";
  }
  if (item.rangeShift === "into-range") return "good";
  return "neutral";
}

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
      className={`badge gap-1.5 transition ${verdictBadge[tone].class}`}
    >
      {Arrow ? <Arrow className="h-3.5 w-3.5 shrink-0" stroke={2} /> : null}
      {item.text}
    </span>
  );
}
