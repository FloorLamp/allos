import {
  episodeDayNumber,
  feverTrend,
  feverTrendLabel,
  type AssembledEpisode,
} from "@/lib/illness-episode-format";
import { severityLabel } from "@/lib/symptoms";
import NotesText from "@/components/NotesText";
import EpisodeTimeline from "@/components/illness/EpisodeTimeline";
import type { TemperatureUnit } from "@/lib/settings";
import { fmtTemp } from "@/lib/units";
import type { ReactNode } from "react";
import Link from "next/link";
import type { EpisodeInRangeEvents } from "@/lib/illness-episode-events";
import EpisodeLatestReadings from "@/components/illness/EpisodeLatestReadings";
import {
  DEFAULT_FORMAT_PREFS,
  formatDateShape,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { RECORDS_CONDITIONS_HREF } from "@/lib/hrefs";

// The printable / shareable illness-episode summary (issue #801). A pure
// presentational server component over the ONE assembled model — reused by the
// authed detail page and the public /share render, so both tell the identical story.
// Dark-mode print legibility is automatic (#794 7c): `darkMode` is scoped to
// `@media not print`, so every `dark:` utility here stops matching under print and
// the light styles render on the forced-white page.

function fmtDate(
  d: string | null,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  if (!d) return "—";
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!parsed) return d;
  return formatDateShape(prefs.dateFormat, +parsed[1], +parsed[2], +parsed[3], {
    monthStyle: "short",
    year: true,
  });
}

function SeverityDots({ severity }: { severity: number }) {
  return (
    <span
      className="inline-flex gap-0.5"
      aria-hidden="true"
      data-testid="episode-severity-dots"
    >
      {[1, 2, 3, 4].map((level) => (
        <span
          key={level}
          className={
            level <= severity
              ? "h-2 w-2 rounded-full bg-rose-500 dark:bg-rose-400"
              : "h-2 w-2 rounded-full bg-slate-200 dark:bg-ink-700"
          }
        />
      ))}
    </span>
  );
}

function SymptomPill({
  symptom,
}: {
  symptom: AssembledEpisode["symptoms"][number];
}) {
  return (
    <li className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-sm dark:bg-ink-800">
      <span className="font-medium text-slate-700 dark:text-slate-200">
        {symptom.label}
      </span>
      <SeverityDots severity={symptom.maxSeverity} />
      <span className="text-xs text-slate-500 dark:text-slate-400">
        {severityLabel(symptom.maxSeverity)}
      </span>
    </li>
  );
}

export default function EpisodeSummary({
  episode,
  note,
  outcome,
  generatedOnDay,
  temperatureUnit = "F",
  timeZone,
  nowIso,
  canEdit = false,
  eventProfileId,
  identity,
  feverFree,
  careEvents,
  linkCareDocuments = true,
  timelineActions,
  timelineTools,
  timelineAfterHistory,
  linkLatestMedication = false,
  linkConditions = false,
  collapsePeakSymptoms = false,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  episode: AssembledEpisode;
  // The episode-level free-text note + outcome annotation (#856 item 8/9). Optional so
  // the public /share render (which has no row) simply omits them.
  note?: string | null;
  outcome?: string | null;
  // The profile-local calendar day this render was PREPARED on (#3573). It was an
  // instant, printed as `generatedAt.slice(0, 10)` — the UTC day — so a summary
  // prepared at 21:00 in UTC−06:00 and carried into a clinic was footed with
  // tomorrow's date. The caller converts: both callers hold the subject profile's
  // zone, and this component's own `timeZone` prop is optional, so resolving here
  // would mean a silent UTC fallback exactly where the defect lives.
  generatedOnDay?: string;
  // The viewer's login temperature-unit preference (#857). Storage is canonical °F;
  // this only changes display. Defaults to °F so the public /share render and any
  // caller without a login pref stay in Fahrenheit.
  temperatureUnit?: TemperatureUnit;
  timeZone?: string;
  // Server-computed "now" for the latest-readings relative ages, forwarded to
  // EpisodeLatestReadings (a client component whose bare new Date() cannot see the
  // frozen test clock).
  nowIso?: string;
  canEdit?: boolean;
  eventProfileId?: number;
  identity?: ReactNode;
  feverFree?: { label: string; met: boolean } | null;
  careEvents?: EpisodeInRangeEvents;
  linkCareDocuments?: boolean;
  timelineActions?: ReactNode;
  timelineTools?: ReactNode;
  timelineAfterHistory?: ReactNode;
  linkLatestMedication?: boolean;
  // Authenticated detail can complete the condition half of the episode association;
  // the public share stays plain text and never points into a login-gated surface.
  linkConditions?: boolean;
  collapsePeakSymptoms?: boolean;
  formatPrefs?: DisplayFormatPrefs;
}) {
  const day = episodeDayNumber(
    episode.start,
    episode.lastActiveDay ?? episode.asOf
  );
  const trend = feverTrendLabel(feverTrend(episode.temperatures));
  const peakSymptomLimit = 5;
  const collapseSymptoms =
    collapsePeakSymptoms && episode.symptoms.length > peakSymptomLimit;
  const leadingSymptoms = collapseSymptoms
    ? episode.symptoms.slice(0, peakSymptomLimit)
    : episode.symptoms;
  const remainingSymptoms = collapseSymptoms
    ? episode.symptoms.slice(peakSymptomLimit)
    : [];

  return (
    <section className="flex flex-col gap-5">
      {/* Header */}
      <header
        className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none"
        data-testid="episode-summary-header"
      >
        {identity ? (
          <div className="mb-4 border-b border-black/5 pb-4 dark:border-white/5">
            {identity}
          </div>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
                {episode.situation} episode
              </h1>
              <span
                className={
                  episode.ongoing
                    ? "badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    : "badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                }
              >
                {episode.ongoing ? "Ongoing" : "Resolved"}
              </span>
            </div>
            {trend ? (
              <p
                className="mt-1 text-sm text-slate-600 dark:text-slate-300"
                data-testid="episode-trend-summary"
              >
                {trend.charAt(0).toUpperCase() + trend.slice(1)}
              </p>
            ) : null}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="section-label">Started</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {fmtDate(episode.start ?? episode.firstDay, formatPrefs)}
            </dd>
          </div>
          <div>
            <dt className="section-label">
              {episode.ongoing ? "As of" : "Ended"}
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {fmtDate(episode.lastActiveDay, formatPrefs)}
            </dd>
          </div>
          <div>
            <dt className="section-label">Day</dt>
            <dd
              className="text-slate-700 dark:text-slate-200"
              data-testid="episode-summary-day"
            >
              {day != null ? day : "—"}
            </dd>
          </div>
          <div>
            <dt className="section-label">Peak temp</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {episode.maxTempF != null
                ? fmtTemp(episode.maxTempF, temperatureUnit)
                : "—"}
            </dd>
          </div>
        </dl>
        <EpisodeLatestReadings
          episode={episode}
          temperatureUnit={temperatureUnit}
          timeZone={timeZone}
          nowIso={nowIso}
          linkMedication={linkLatestMedication}
          feverFree={feverFree}
          className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
        />
        {outcome ? (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            <span className="section-label mr-2">Outcome</span>
            {outcome}
          </p>
        ) : null}
        {note ? (
          <div className="mt-3">
            <div className="section-label mb-1">Episode note</div>
            <NotesText
              as="p"
              className="text-sm text-slate-600 dark:text-slate-300"
              notes={note}
            />
          </div>
        ) : null}
        {episode.symptoms.length > 0 && (
          <div
            className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
            data-testid="episode-symptoms"
          >
            <h2 className="section-label mb-2">Peak symptoms</h2>
            <ul
              className={`flex flex-wrap gap-2 ${collapseSymptoms ? "print:hidden" : ""}`}
            >
              {leadingSymptoms.map((symptom) => (
                <SymptomPill key={symptom.symptom} symptom={symptom} />
              ))}
            </ul>
            {collapseSymptoms ? (
              <>
                <details className="mt-2 print:hidden">
                  <summary className="cursor-pointer text-xs text-link">
                    Show {remainingSymptoms.length} more
                  </summary>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {remainingSymptoms.map((symptom) => (
                      <SymptomPill key={symptom.symptom} symptom={symptom} />
                    ))}
                  </ul>
                </details>
                <ul
                  className="hidden flex-wrap gap-2 print:flex"
                  data-testid="episode-print-symptoms"
                >
                  {episode.symptoms.map((symptom) => (
                    <SymptomPill key={symptom.symptom} symptom={symptom} />
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}

        {episode.conditions.length > 0 && (
          <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
            <h2 className="section-label mb-2">Linked conditions</h2>
            <div className="flex flex-wrap gap-2">
              {episode.conditions.map((c) =>
                linkConditions ? (
                  <Link
                    key={c.id}
                    href={RECORDS_CONDITIONS_HREF}
                    className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                  >
                    {c.name} · {c.status}
                  </Link>
                ) : (
                  <span
                    key={c.id}
                    className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                  >
                    {c.name} · {c.status}
                  </span>
                )
              )}
            </div>
          </div>
        )}
      </header>

      <EpisodeTimeline
        episode={episode}
        canEdit={canEdit}
        temperatureUnit={temperatureUnit}
        profileId={eventProfileId}
        careEvents={careEvents}
        linkCareDocuments={linkCareDocuments}
        actions={timelineActions}
        tools={timelineTools}
        afterHistory={timelineAfterHistory}
        tz={timeZone}
      />

      {generatedOnDay && (
        <EpisodeSummaryFooter generatedOnDay={generatedOnDay} />
      )}
    </section>
  );
}

export function EpisodeSummaryFooter({
  generatedOnDay,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  // A `YYYY-MM-DD` calendar day, already resolved in the subject profile's zone
  // (#3573) — never an instant, so there is nothing here left to truncate.
  generatedOnDay: string;
  formatPrefs?: DisplayFormatPrefs;
}) {
  return (
    <p className="text-xs text-slate-400" data-testid="episode-summary-footer">
      Prepared {fmtDate(generatedOnDay, formatPrefs)}. For reference only — not
      a medical record.
    </p>
  );
}
