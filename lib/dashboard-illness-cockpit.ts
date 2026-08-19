import { now as clockNow } from "./clock";
import { today } from "./db";
import type { EpisodeMedSuggestion } from "./episode-med-reconcile";
import {
  episodeAlternateLogDate,
  type AssembledEpisode,
} from "./illness-episode-format";
import type { IntakeCatalogOptions } from "./queries/intake-options";
import {
  getCustomSymptomNames,
  getIntakeCatalogOptions,
  getPediatricFormContext,
  getPrnMedicationsForQuickLog,
  getSymptomLogOrder,
  getEpisodeMedReconciliations,
} from "./queries";
import type { PrnMedForQuickLog } from "./queries/intake/adherence";
import type { PediatricFormContext } from "./prn-dosing";
import { schoolReturnStatusesFor } from "./school-return-data";
import { schoolReturnCompactClause } from "./school-return";
import {
  getStaleNudgeAcked,
  type StaleEpisodeNudge,
} from "./stale-episode-data";
import { computeStaleEpisode } from "./stale-episode";
import { getTimezone, type TemperatureUnit, type WeightUnit } from "./settings";

export interface DashboardIllnessControls {
  altDate?: string;
  staleNudge: StaleEpisodeNudge | null;
  medReconciliation: EpisodeMedSuggestion[];
  prnMeds: PrnMedForQuickLog[];
  intakeOptions: IntakeCatalogOptions;
  pediatric: PediatricFormContext;
  initial: Record<string, number>;
  initialAlt?: Record<string, number>;
  initialNotes: Record<string, string>;
  initialAltNotes?: Record<string, string>;
  customNames: string[];
  rankedKeys: string[];
}

export interface DashboardIllnessCockpitModel {
  date: string;
  temperatureUnit: TemperatureUnit;
  timeZone: string;
  nowIso: string;
  feverFree: { label: string; met: boolean } | null;
  controls: DashboardIllnessControls | null;
}

function dayRecords(episodes: readonly AssembledEpisode[], date: string) {
  const initial: Record<string, number> = {};
  const notes: Record<string, string> = {};
  for (const episode of episodes) {
    for (const symptom of episode.symptoms) {
      const row = symptom.points.find((point) => point.date === date);
      if (!row) continue;
      initial[symptom.symptom] = row.severity;
      if (row.note) notes[symptom.symptom] = row.note;
    }
  }
  return { initial, notes };
}

// One profile-level dashboard cockpit gather. Episodes are already assembled from one
// broad fact read; every remaining control/read model below is likewise gathered once
// per profile and projected across episodes in memory.
export function gatherDashboardIllnessCockpits(
  profileId: number,
  episodes: readonly (AssembledEpisode & { id: number })[],
  options: {
    canWrite: boolean;
    temperatureUnit: TemperatureUnit;
    weightUnit: WeightUnit;
    now?: Date;
  }
): Map<number, DashboardIllnessCockpitModel> {
  const out = new Map<number, DashboardIllnessCockpitModel>();
  if (episodes.length === 0) return out;
  const date = today(profileId);
  const timeZone = getTimezone(profileId);
  const now = options.now ?? clockNow();
  const nowIso = now.toISOString();
  const school = schoolReturnStatusesFor(profileId, episodes, now.getTime());

  let sharedControls: Omit<
    DashboardIllnessControls,
    | "altDate"
    | "staleNudge"
    | "medReconciliation"
    | "initialAlt"
    | "initialAltNotes"
  > | null = null;
  let byDate = new Map<string, ReturnType<typeof dayRecords>>();
  let staleAcked = new Set<number>();
  let reconciliations = new Map<number, EpisodeMedSuggestion[]>();
  if (options.canWrite) {
    const dates = new Set([date]);
    for (const episode of episodes) {
      const alternate = episodeAlternateLogDate(
        episode.ongoing,
        episode.firstDay,
        date
      );
      if (alternate) dates.add(alternate);
    }
    byDate = new Map([...dates].map((day) => [day, dayRecords(episodes, day)]));
    const current = byDate.get(date) ?? { initial: {}, notes: {} };
    sharedControls = {
      prnMeds: getPrnMedicationsForQuickLog(profileId),
      intakeOptions: getIntakeCatalogOptions(profileId),
      pediatric: getPediatricFormContext(profileId, options.weightUnit),
      initial: current.initial,
      initialNotes: current.notes,
      customNames: getCustomSymptomNames(profileId),
      rankedKeys: getSymptomLogOrder(profileId),
    };
    staleAcked = getStaleNudgeAcked(profileId);
    reconciliations = getEpisodeMedReconciliations(
      profileId,
      episodes.map((episode) => ({
        id: episode.id,
        start: episode.start,
        endInclusive: episode.end ?? episode.asOf,
      }))
    );
  }

  for (const episode of episodes) {
    const schoolStatus = school.get(episode.id) ?? null;
    const alternate = options.canWrite
      ? (episodeAlternateLogDate(episode.ongoing, episode.firstDay, date) ??
        undefined)
      : undefined;
    const alternateRecords = alternate ? byDate.get(alternate) : undefined;
    const stale =
      options.canWrite && !staleAcked.has(episode.id)
        ? computeStaleEpisode(episode)
        : null;
    const staleNudge =
      stale?.isStale &&
      stale.lastActivityDate != null &&
      stale.quietDays != null
        ? {
            episodeId: episode.id,
            situation: episode.situation,
            lastActivityDate: stale.lastActivityDate,
            quietDays: stale.quietDays,
          }
        : null;
    out.set(episode.id, {
      date,
      temperatureUnit: options.temperatureUnit,
      timeZone,
      nowIso,
      feverFree: schoolStatus
        ? {
            label: schoolReturnCompactClause(schoolStatus).replace(
              /^fever-free/,
              "Fever-free"
            ),
            met: schoolStatus.met,
          }
        : null,
      controls: sharedControls
        ? {
            ...sharedControls,
            altDate: alternate,
            initialAlt: alternateRecords?.initial,
            initialAltNotes: alternateRecords?.notes,
            staleNudge,
            medReconciliation: reconciliations.get(episode.id) ?? [],
          }
        : null,
    });
  }
  return out;
}
