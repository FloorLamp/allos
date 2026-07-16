"use client";

import { useRouter } from "next/navigation";
import SymptomLogBar from "@/app/(app)/symptoms/SymptomLogBar";
import type { Symptom } from "@/lib/symptoms";
import type { TemperatureUnit } from "@/lib/settings";

// In-place symptom + temperature logging on the episode page (issue #856 item 11). This
// mounts the SAME SymptomLogBar the dashboard card uses — ZERO forked logging logic (the
// shared-content rule) — via its existing public props; being on the episode page IS the
// illness context, so the "mark as illness" bridge is off. Guarded by a source-scan test
// pinning it's the same component.
//
// Open episode: today + yesterday backfill toggle (parity with the dashboard card).
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
  rangeStart,
  rangeEnd,
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
  rangeStart: string | null;
  rangeEnd: string | null;
}) {
  const router = useRouter();

  return (
    <div className="card mt-5" data-testid="episode-log-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="section-label">Log how things are going</h2>
        {!ongoing && (
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Day
            <input
              type="date"
              className="input h-8 w-auto py-1 text-xs"
              defaultValue={date}
              min={rangeStart ?? undefined}
              max={rangeEnd ?? undefined}
              data-testid="episode-log-day"
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v)
                  router.push(`/medical/episodes/${episodeId}?logDay=${v}`);
              }}
            />
          </label>
        )}
      </div>
      <SymptomLogBar
        date={date}
        altDate={ongoing ? altDate : undefined}
        altDateLabel={altDateLabel}
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
      />
    </div>
  );
}
