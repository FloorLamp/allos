import {
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus,
} from "@tabler/icons-react";
import {
  PILLAR_TONE_LABEL,
  type Pillar,
  type PillarTone,
} from "@/lib/longevity-pillars";

export const PILLAR_TONE_CLASS: Record<PillarTone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-rose-600 dark:text-rose-400",
  neutral: "text-slate-700 dark:text-slate-200",
};

const PILLAR_TONE_BADGE_CLASS: Record<PillarTone, string> = {
  good: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  neutral: "",
};

// The non-color channel for a pillar's judgment (WCAG 1.4.1, issue #1220): the
// PILLAR_TONE_LABEL text as a chip beside the colored value. Renders nothing for
// `neutral` (no judgment → nothing to announce). Shared by Standing and the
// Longevity page's PillarStat so both surfaces style the same facts identically.
export function PillarToneBadge({ tone }: { tone: PillarTone }) {
  const label = PILLAR_TONE_LABEL[tone];
  if (!label) return null;
  return (
    <span
      className={`badge ${PILLAR_TONE_BADGE_CLASS[tone]}`}
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
