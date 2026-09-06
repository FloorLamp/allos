import {
  combinedMsv,
  isCombinedEstimated,
  backgroundEquivalentLabel,
  formatScopeMsv,
  doseFramingNote,
  doseChipLabel,
  doseSourceNote,
  doseExclusionNote,
  describesAnyStudy,
  doseSplitIsRedundant,
  doseScopeCountLabel,
  type DoseBreakdown,
} from "@/lib/radiation-dose";
import { studyDisplayLabel } from "@/lib/imaging-study";
import { formatDateWithYear, type DisplayFormatPrefs } from "@/lib/format-date";
import type { ImagingStudy } from "@/lib/types";
import Disclosure from "@/components/Disclosure";

// The calm, informational cumulative-radiation-dose card on the Imaging page (#703),
// with the breakdown that answers "which studies is that?" in place (#2970).
//
// Pure presentational: it formats the ONE pure computation (lib/radiation-dose.ts) and
// never derives numbers of its own, so the page and any future surface agree. It
// renders whenever the record has an imaging study to speak about, and NOTHING when it
// has none — a record whose studies are all undated, unclassified or non-ionizing has a
// no-total card that names them, because that record is exactly the one whose studies
// are otherwise invisible (its undated X-ray still carries an estimate chip on its list
// row). Tone is deliberately non-alarmist — a running estimate for context, never a
// "you've had too much" verdict; `pediatric` swaps in the age-appropriate framing the
// app already uses on child surfaces (#150, #489).
//
// The headline is ALL RECORDS and never ages downward; the trailing-3-year figure is a
// secondary recent-intensity lens beside it. The disclosure is a native <details>, so
// it opens with JS off and in-page find still reaches the rows.
//
// THE ADDITION HAS TO WORK. Every scope figure here — the headline, the recorded and
// estimated split, the lens — goes through formatScopeMsv, which prints the sum of the
// figures the rows print; the rows print formatMsv, the same chip the study list shows.
// A total re-rounded independently of its rows disagreed with them in ordinary cases
// (#2970 R5), and a decomposition whose parts do not add up is not an explanation. What
// that costs — a printed total up to 0.5% off the sum of the TRUE doses, ratified because
// it sits two orders of magnitude inside the uncertainty the figure already declares — is
// written out beside `formatScopeMsv`. Read that before making this card sum anything of
// its own.
export default function RadiationDoseCard({
  breakdown,
  pediatric,
  fmt,
}: {
  breakdown: DoseBreakdown<ImagingStudy>;
  pediatric: boolean;
  fmt: DisplayFormatPrefs;
}) {
  const { allRecords, window: lens, contributions, exclusions } = breakdown;
  if (!describesAnyStudy(breakdown)) return null;

  const hasTotal = allRecords.hasAnyDose;
  const total = combinedMsv(allRecords);
  const estimated = isCombinedEstimated(allRecords);
  const background = backgroundEquivalentLabel(allRecords);
  const lensTotal = combinedMsv(lens);
  // A split that splits nothing is three statements of one number (#3498 item 2).
  // The decision is lib/radiation-dose's, over the figures as PRINTED — this card
  // only renders the answer, so the sub-lines cannot come back on one surface and
  // not another.
  const splitRedundant = doseSplitIsRedundant(breakdown);
  const scopeCount = doseScopeCountLabel(allRecords);

  return (
    <div
      data-testid="radiation-dose-card"
      className="card border-l-4 border-l-brand-400 dark:border-l-brand-600"
    >
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Cumulative radiation dose
      </h2>

      {hasTotal ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-2">
          <span
            data-testid="radiation-dose-total"
            className="text-2xl font-bold text-brand-700 dark:text-brand-300"
          >
            {estimated ? "≈ " : ""}
            {formatScopeMsv(allRecords, total)}
          </span>
          {/* The collapsed context (#3498 item 2): the half of the split lines that
              was NOT a restatement of the headline — how many studies, and what
              they came in as. It replaces the chip too, since "1 estimated study"
              already says the figure includes an estimate. */}
          {splitRedundant && scopeCount ? (
            <span
              data-testid="radiation-dose-context"
              className="text-sm text-slate-600 dark:text-slate-300"
            >
              · {scopeCount}
            </span>
          ) : (
            estimated && (
              <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                includes estimates
              </span>
            )
          )}
        </div>
      ) : (
        <p
          data-testid="radiation-dose-none"
          className="mt-2 text-sm text-slate-600 dark:text-slate-300"
        >
          Nothing in your records counts toward a dose.
        </p>
      )}

      {/* The completeness caveat lives in the LABEL, not in the arithmetic: Allos only
          knows what has been imported, so the total says how far back it reaches
          instead of quietly dropping older studies (#2970). */}
      {hasTotal && allRecords.earliest && (
        <p
          data-testid="radiation-dose-since"
          className="mt-1 text-sm text-slate-600 dark:text-slate-300"
        >
          From your records, since{" "}
          {formatDateWithYear(allRecords.earliest, fmt)}.
        </p>
      )}

      {hasTotal && !splitRedundant && (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
          {allRecords.recordedCount > 0 && (
            <div>
              <dt className="inline text-slate-500 dark:text-slate-400">
                Recorded:{" "}
              </dt>
              <dd className="inline font-medium">
                {formatScopeMsv(allRecords, allRecords.recordedMsv)}{" "}
                <span className="font-normal text-slate-400">
                  ({allRecords.recordedCount}{" "}
                  {allRecords.recordedCount === 1 ? "study" : "studies"})
                </span>
              </dd>
            </div>
          )}
          {allRecords.estimatedCount > 0 && (
            <div>
              <dt className="inline text-slate-500 dark:text-slate-400">
                Estimated:{" "}
              </dt>
              <dd className="inline font-medium">
                {formatScopeMsv(allRecords, allRecords.estimatedMsv)}{" "}
                <span className="font-normal text-slate-400">
                  ({allRecords.estimatedCount}{" "}
                  {allRecords.estimatedCount === 1 ? "study" : "studies"})
                </span>
              </dd>
            </div>
          )}
          {lens.windowYears != null && (
            <div data-testid="radiation-dose-window">
              <dt className="inline text-slate-500 dark:text-slate-400">
                Last {lens.windowYears} years:{" "}
              </dt>
              <dd className="inline font-medium">
                {isCombinedEstimated(lens) ? "≈ " : ""}
                {formatScopeMsv(lens, lensTotal)}
              </dd>
            </div>
          )}
        </dl>
      )}

      {background && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          For context, roughly the same as {background} of natural background
          radiation.
        </p>
      )}

      <Disclosure className="mt-3" data-testid="radiation-dose-breakdown">
        <summary
          data-testid="radiation-dose-breakdown-toggle"
          className="fold-control flex list-none items-center gap-1 text-xs font-medium text-brand-700 [&::-webkit-details-marker]:hidden dark:text-brand-400"
        >
          <span className="group-open:hidden">
            {contributions.length > 0
              ? "What this adds up to"
              : "Why nothing counted"}
          </span>
          <span className="hidden group-open:inline">Hide the studies</span>
        </summary>

        <ul className="mt-2 space-y-1.5">
          {contributions.map((c) => {
            const chip = doseChipLabel(c.dose);
            return (
              <li
                key={c.study.id}
                data-testid="radiation-dose-contribution"
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
              >
                <span className="whitespace-nowrap text-xs text-slate-500 tabular-nums dark:text-slate-400">
                  {formatDateWithYear(c.date, fmt)}
                </span>
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {studyDisplayLabel(c.study)}
                </span>
                {chip && (
                  <span
                    data-testid="radiation-dose-contribution-figure"
                    className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {chip}
                  </span>
                )}
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {doseSourceNote(c.dose)}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Named, not silent: a study that contributed nothing says so and says why,
            or the breakdown re-creates one level down the very gap it removes. */}
        {exclusions.length > 0 && (
          <>
            <p className="mt-3 text-xs font-medium text-slate-500 dark:text-slate-400">
              Not counted
            </p>
            <ul className="mt-1 space-y-1.5">
              {exclusions.map((x) => (
                <li
                  key={x.study.id}
                  data-testid="radiation-dose-exclusion"
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                >
                  <span className="whitespace-nowrap text-xs text-slate-500 tabular-nums dark:text-slate-400">
                    {x.date ? formatDateWithYear(x.date, fmt) : "No date"}
                  </span>
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {studyDisplayLabel(x.study)}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {doseExclusionNote(x.reason)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Disclosure>

      {hasTotal && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {doseFramingNote(pediatric)}
        </p>
      )}
    </div>
  );
}
