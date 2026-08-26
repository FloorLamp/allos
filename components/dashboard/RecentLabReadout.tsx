import Link from "next/link";
import CardSectionHeader from "@/components/CardSectionHeader";
import { MedicalValue } from "@/components/ui";
import { RECENT_LAB_STALE_LABEL, type RecentLabRow } from "@/lib/recent-labs";
import { glanceAgeToken } from "@/lib/glance-age";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// One latest clinical result, flattened for display by the page. Its selection
// policy lives in lib/recent-labs (issue #313).
export type { RecentLabRow };

export default function RecentLabReadout({
  row,
  today,
}: {
  row: RecentLabRow;
  today: string;
}) {
  const age = glanceAgeToken({
    date: row.date,
    today,
    freshness: row.freshness,
    form: "compact",
    floorLabel: RECENT_LAB_STALE_LABEL,
  });
  return (
    <div className="card">
      <CardSectionHeader
        title="Recent clinical results"
        href="/results/clinical-results"
      />
      <ul className="space-y-1.5">
        <li
          data-testid="recent-lab-row"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"
        >
          <Link
            href={row.href}
            className="min-w-0 grow basis-40 break-words text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline dark:text-slate-200 dark:hover:text-brand-400"
          >
            {row.name}
          </Link>
          <span className="ml-auto shrink-0 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">
            {/* #1220 fixed the color-only severity here, with a SECOND
                      visible label built beside the component. #2315 folds that
                      into MedicalValue itself, so one component owns "value +
                      flag + severity word" for every surface that wants it — and
                      the word is announced once rather than twice. The tone color
                      comes from MedicalValue's own flag class, the same tiers the
                      former aggregate's local map restated. */}
            <MedicalValue
              value={row.value}
              unit={row.unit}
              flag={row.flag}
              showFlagLabel
            />
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center">
            <span
              data-testid="recent-lab-date"
              data-stale={age.stale ? "true" : undefined}
              className={`w-12 whitespace-nowrap text-right text-xs sm:w-14 ${age.className}`}
            >
              {age.text}
            </span>
            {age.title ? <InfoTooltipIcon label={age.title} /> : null}
          </span>
        </li>
      </ul>
    </div>
  );
}
