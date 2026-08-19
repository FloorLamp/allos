import Link from "next/link";
import { IconChartBar } from "@tabler/icons-react";
import CardSectionHeader from "@/components/CardSectionHeader";
import {
  recapLineAnnotation,
  recapRangeLabel,
  type Recap,
  type RecapLine,
} from "@/lib/recap";
import { recapScaleEntry } from "@/lib/recap-scale";
import {
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "@/lib/format-date";

// One recap line as one dashboard statement. The shared annotation and range
// formatters keep the atom and recap notification aligned (#221).
export default function RecapLineAtom({
  recap,
  line,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  recap: Recap;
  line: RecapLine;
  formatPrefs?: DisplayFormatPrefs;
}) {
  const scale = recapScaleEntry(recap.scale);
  const annotation = recapLineAnnotation(line);
  return (
    <div className="card" data-testid="weekly-recap">
      <CardSectionHeader
        title={scale.label}
        href="/timeline"
        action={
          <Link
            href="/retrospective"
            data-testid="weekly-recap-retrospective-link"
            className="text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            See your year
          </Link>
        }
      />
      <div className="mb-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
        <IconChartBar className="h-4 w-4 text-brand-500" />
        <span data-testid="weekly-recap-range">
          {recapRangeLabel(recap.start, recap.end, formatPrefs)}
        </span>
      </div>
      <dl className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          {/* A bare line is already self-labelled (#1935) — its label stays
                      for screen readers so the description list keeps its pairs,
                      but printing it would label the row twice. */}
          <dt
            className={
              line.bare ? "sr-only" : "text-slate-500 dark:text-slate-400"
            }
          >
            {line.label}
          </dt>
          <dd className={line.bare ? "min-w-0" : "min-w-0 text-right"}>
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {line.value}
            </span>
            {annotation && (
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {annotation}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
