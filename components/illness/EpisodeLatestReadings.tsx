"use client";

import {
  episodeLatestDose,
  readingClockWithRelativeAge,
  relativeEpisodeDateLabel,
  type AssembledEpisode,
  type EpisodeReadingTimeContext,
} from "@/lib/illness-episode-format";
import type { TemperatureUnit } from "@/lib/settings";
import { fmtTemp } from "@/lib/units";
import { medicationHref } from "@/lib/hrefs";
import {
  formatClockValue,
  formatDateShape,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import Link from "next/link";

function shortDate(date: string, prefs: DisplayFormatPrefs): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return formatDateShape(prefs.dateFormat, +parsed[1], +parsed[2], +parsed[3], {
    monthStyle: "short",
  });
}

function whenLabel(
  episode: AssembledEpisode,
  date: string,
  time: string | null,
  prefs: DisplayFormatPrefs,
  timeContext?: EpisodeReadingTimeContext
): string {
  const day = episode.ongoing
    ? (relativeEpisodeDateLabel(date, episode.asOf) ?? shortDate(date, prefs))
    : shortDate(date, prefs);
  if (!time) return day;
  const clock =
    episode.ongoing && day === "Today"
      ? readingClockWithRelativeAge(date, time, timeContext)
      : formatClockValue(time, prefs.timeFormat);
  return episode.ongoing && day === "Today" ? clock : `${day}, ${clock}`;
}

// Flat, at-a-glance recency signals shared by the dashboard cockpit and episode header.
// Both values come from the assembled episode, so they update with the same refresh as
// the timeline and never disagree with its latest event.
export default function EpisodeLatestReadings({
  episode,
  temperatureUnit = "F",
  linkMedication = false,
  feverFree,
  timeZone,
  className = "",
}: {
  episode: AssembledEpisode;
  temperatureUnit?: TemperatureUnit;
  linkMedication?: boolean;
  feverFree?: { label: string; met: boolean } | null;
  timeZone?: string;
  className?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const temperature = episode.latestTemp;
  const dose = episodeLatestDose(episode);

  return (
    <dl
      className={`grid gap-x-6 gap-y-2 ${feverFree ? "sm:grid-cols-3" : "sm:grid-cols-2"} ${className}`}
      data-testid="episode-latest-readings"
    >
      <div className="min-w-0">
        <dt className="section-label">Last temperature</dt>
        <dd
          className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm"
          data-testid="episode-last-temperature"
        >
          {temperature ? (
            <>
              <span
                data-testid="episode-last-temperature-value"
                className={`font-medium tabular-nums ${
                  temperature.flag === "high"
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-slate-700 dark:text-slate-200"
                }`}
              >
                {fmtTemp(temperature.degF, temperatureUnit)}
              </span>
              <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                {whenLabel(
                  episode,
                  temperature.date,
                  temperature.time,
                  formatPrefs,
                  { timeZone, timeFormat: formatPrefs.timeFormat }
                )}
              </span>
            </>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
              Not logged
            </span>
          )}
        </dd>
      </div>

      <div className="min-w-0">
        <dt className="section-label">Last Meds</dt>
        <dd
          className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm"
          data-testid="episode-last-dose"
        >
          {dose ? (
            <>
              <span className="min-w-0 font-medium text-slate-700 dark:text-slate-200">
                {linkMedication ? (
                  <Link
                    href={medicationHref(dose.itemId)}
                    className="text-slate-700 underline decoration-slate-300 underline-offset-2 transition hover:text-brand-600 dark:text-slate-200 dark:decoration-slate-600 dark:hover:text-brand-400"
                  >
                    {dose.name}
                  </Link>
                ) : (
                  dose.name
                )}
                {dose.amount ? ` · ${dose.amount}` : ""}
              </span>
              <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                {whenLabel(episode, dose.date, dose.time, formatPrefs, {
                  timeZone,
                  timeFormat: formatPrefs.timeFormat,
                })}
              </span>
            </>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">
              Not logged
            </span>
          )}
        </dd>
      </div>

      {feverFree ? (
        <div className="min-w-0">
          <dt className="section-label">Fever status</dt>
          <dd className="mt-0.5 text-sm">
            <span
              data-testid="school-return-status"
              className={`font-medium tabular-nums ${
                feverFree.met
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {feverFree.label}
            </span>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
