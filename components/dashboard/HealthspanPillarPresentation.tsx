import {
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import {
  VERDICT_TONE_LABEL,
  verdictBadge,
  type VerdictTone,
} from "@/lib/chart-colors";
import type { Pillar } from "@/lib/longevity-pillars";

// The non-color channel for a pillar's judgment (WCAG 1.4.1, issue #1220): the
// VERDICT_TONE_LABEL text as a chip beside the colored value. Renders nothing for
// `neutral` (no judgment → nothing to announce), which is also why the badge
// never needs the palette's neutral pill. Shared by Standing and the Longevity
// page's PillarStat so both surfaces style the same facts identically.
export function PillarToneBadge({ tone }: { tone: VerdictTone }) {
  const label = VERDICT_TONE_LABEL[tone];
  if (!label) return null;
  return (
    <span
      className={`badge ${verdictBadge[tone].class}`}
      data-testid="pillar-tone-badge"
    >
      {label}
    </span>
  );
}

export function TrendArrow({ pillar }: { pillar: Pillar }) {
  if (!pillar.trend) return null;
  const Icon =
    pillar.trend.direction === "up"
      ? IconArrowUpRight
      : pillar.trend.direction === "down"
        ? IconArrowDownRight
        : IconMinus;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400">
      <Icon className="h-3.5 w-3.5" stroke={1.75} aria-hidden />
      {pillar.trend.label}
    </span>
  );
}
