"use client";

import { useRouter } from "next/navigation";
import SymptomLogBar from "@/components/illness/SymptomLogBar";
import type { Symptom } from "@/lib/symptoms";
import type { TemperatureUnit } from "@/lib/settings";
import DateField from "@/components/DateField";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import type { ReactNode } from "react";
import type { PrnMedForQuickLog } from "@/lib/queries";
import type { IntakeFormContext } from "@/lib/intake-form-context";

// In-place symptom + temperature logging on the episode page (issue #856 item 11). This
// mounts the SAME SymptomLogBar the dashboard card uses — ZERO forked logging logic (the
// shared-content rule) — via its existing public props; being on the episode page IS the
// illness context, so the "mark as illness" bridge is off. Guarded by a source-scan test
// pinning it's the same component.
//
// Open episode: today + yesterday backfill toggle (parity with the dashboard card).
// The toggle is the PANEL's day context (#4691), supplied above the bar rather than
// held inside it, so it means the same thing here as it does on the cockpit — where a
// Meds row is a sibling that reads it too.
// Closed episode: a day picker over the episode's range navigates (?logDay=…) so the
// server re-renders the bar anchored to the chosen day with that day's severities — the
// backfill mode for populating a retro-created episode. The picker composes AROUND the
// bar; it never restructures the bar's internals (the #857 partition).
export default function EpisodeLogPanel({
  episodeId,
  ongoing,
  date,
  altDate,
  altDateLabel,
  initial,
  initialAlt,
  initialNotes,
  initialAltNotes,
  symptoms,
  customNames,
  rankedKeys,
  temperatureUnit,
  timeZone,
  rangeStart,
  rangeEnd,
  profileId,
  photoControl,
  antipyreticMeds,
  intakeContext,
  nowIso,
}: {
  episodeId: number;
  ongoing: boolean;
  date: string;
  altDate?: string;
  altDateLabel?: string;
  initial: Record<string, number>;
  initialAlt?: Record<string, number>;
  initialNotes?: Record<string, string>;
  initialAltNotes?: Record<string, string>;
  symptoms: Symptom[];
  customNames: string[];
  rankedKeys?: string[];
  temperatureUnit?: TemperatureUnit;
  timeZone: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  photoControl?: ReactNode;
  // The cross-profile write target (issue #879) — passed straight to SymptomLogBar so a
  // caregiver logs a household member's symptoms/temperature from THEIR episode page
  // without switching. Absent on the acting profile's own page.
  profileId?: number;
  // THE FOLD'S DOSE OFFER (#4712, owner ruling 2026-09-04 11:20 UTC part 2), passed
  // straight through to the bar. The page's own Meds section yields while the offer
  // is live (`YieldToDoseOffer` there), which is what makes offering the antipyretic
  // here a second PLACE for one chip rather than a second COPY of it.
  antipyreticMeds?: PrnMedForQuickLog[];
  intakeContext?: IntakeFormContext;
  nowIso?: string;
}) {
  const router = useRouter();

  return (
    <CockpitDayProvider
      date={date}
      altDate={ongoing ? altDate : undefined}
      altDateLabel={altDateLabel}
      tz={timeZone}
    >
      <div data-testid="episode-log-panel">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Symptoms &amp; Temperature
            </h3>
            {!ongoing && (
              <p
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                data-testid="resolved-episode-backfill-note"
              >
                Add a past update to this episode. This won’t reopen it.
              </p>
            )}
          </div>
          {(!ongoing || photoControl) && (
            <div
              className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end"
              data-testid="episode-log-header-actions"
            >
              {!ongoing && (
                <>
                  <label className="label mb-0" htmlFor="episode-log-date">
                    Entry date
                  </label>
                  <DateField
                    id="episode-log-date"
                    value={date}
                    min={rangeStart ?? undefined}
                    max={rangeEnd ?? undefined}
                    inputClassName="h-8 w-40 py-1 text-xs normal-case tracking-normal"
                    onChange={(v) => {
                      if (v)
                        router.push(
                          `/medical/episodes/${episodeId}?logDay=${v}`
                        );
                    }}
                  />
                </>
              )}
              {photoControl}
            </div>
          )}
        </div>
        <SymptomLogBar
          date={date}
          altDate={ongoing ? altDate : undefined}
          initial={initial}
          initialAlt={initialAlt}
          initialNotes={initialNotes}
          initialAltNotes={initialAltNotes}
          symptoms={symptoms}
          customNames={customNames}
          rankedKeys={rankedKeys}
          suggestActivateIllness={false}
          showTemperature
          temperatureUnit={temperatureUnit}
          timeZone={timeZone}
          profileId={profileId}
          showTitle={false}
          analysisHref={profileId == null ? "/trends/symptoms" : undefined}
          antipyreticMeds={antipyreticMeds}
          intakeContext={intakeContext}
          nowIso={nowIso}
          // ONGOING IS THE ANSWER for the episode half, not the id this bar omits
          // above (established newest-open default association): viewing the open
          // episode itself IS having one; a closed/backfilled episode is not.
          hasOpenEpisode={ongoing}
        />
      </div>
    </CockpitDayProvider>
  );
}
