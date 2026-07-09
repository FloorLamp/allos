import Link from "next/link";
import { IconArrowDownRight, IconArrowUpRight } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { buildDigestSeries } from "@/lib/trends-series";
import { summarizeTrends, type TrendItem } from "@/lib/trends-digest";
import type { DateRange } from "@/lib/timeline-format";

// "What's trending" digest for the Trends Overview (issue #212, Phase 2). Feeds
// every candidate series (metrics + biomarkers, windowed to the shared range) to
// the pure summarizeTrends, which flags the ones that actually moved (or crossed a
// reference range) and ranks them. Renders the top few as compact chips. Nothing
// renders when nothing is meaningfully moving.
export default function TrendingDigest({ range }: { range: DateRange }) {
  const { login, profile } = requireSession();
  const restricted = isTrainingRestricted(profile.id);
  const series = buildDigestSeries(profile.id, login.id, range, restricted);
  const items = summarizeTrends(series, { limit: 6 });
  if (items.length === 0) return null;

  const hrefFor = (item: TrendItem): string | null =>
    item.key.startsWith("bio:")
      ? `/biomarkers/view?name=${encodeURIComponent(item.key.slice("bio:".length))}`
      : null;

  // A range crossing is what matters clinically, so color those; otherwise the
  // chip is neutral (up/down alone isn't inherently good or bad across metrics).
  const toneClass = (item: TrendItem): string => {
    if (item.rangeShift === "out-of-range")
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300";
    if (item.rangeShift === "into-range")
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300";
    return "border-slate-200 bg-white/70 text-slate-700 dark:border-white/10 dark:bg-ink-900/70 dark:text-slate-200";
  };

  return (
    <div className="card">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        What&rsquo;s trending{" "}
        <span className="font-normal text-slate-400 dark:text-slate-500">
          over this window
        </span>
      </h2>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const href = hrefFor(item);
          const Arrow =
            item.direction === "up" ? IconArrowUpRight : IconArrowDownRight;
          const inner = (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition ${toneClass(
                item
              )}`}
            >
              <Arrow className="h-3.5 w-3.5 shrink-0" stroke={2} />
              {item.text}
            </span>
          );
          return href ? (
            <Link key={item.key} href={href} className="hover:opacity-80">
              {inner}
            </Link>
          ) : (
            <span key={item.key}>{inner}</span>
          );
        })}
      </div>
    </div>
  );
}
