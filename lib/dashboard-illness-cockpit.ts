import { now as clockNow } from "./clock";
import { today } from "./db";
import type { EpisodeMedSuggestion } from "./episode-med-reconcile";
import {
  episodeAlternateLogDate,
  isLoggedSymptomSeries,
  type AssembledEpisode,
  type CockpitRecovery,
} from "./illness-episode-format";
import type { IntakeCatalogOptions } from "./queries/intake-options";
import {
  getCustomSymptomNames,
  getIntakeCatalogOptions,
  getPrnMedicationsForQuickLog,
  getSymptomLogOrder,
  getEpisodeMedReconciliations,
} from "./queries";
import type { PrnMedForQuickLog } from "./queries/intake/adherence";
import {
  loadIntakeFormContext,
  type IntakeFormContext,
} from "./intake-form-context";
import { schoolReturnStatusesFor } from "./school-return-data";
import { schoolReturnCompactLabel } from "./school-return";
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
  // The whole subject context the cockpit's add-medication fold feeds its form
  // (#4609) — this profile's, not the viewer's.
  intakeForm: IntakeFormContext;
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
  // THE COUNTDOWN, NOT ONLY ITS LABEL (#4752 item 1). The recovery-led header draws a
  // progress ring, so the cleared hours and the convention's threshold have to survive
  // the gather rather than being folded into a string nothing can measure.
  feverFree: CockpitRecovery | null;
  controls: DashboardIllnessControls | null;
}

function dayRecords(episodes: readonly AssembledEpisode[], date: string) {
  const initial: Record<string, number> = {};
  const notes: Record<string, string> = {};
  for (const episode of episodes) {
    for (const symptom of episode.symptoms) {
      // THE SAFETY NARROWING. These maps seed `SymptomLogBar`'s severity chips and its
      // `setSymptomSeverityCore` writes, so a derived row reaching here would offer a
      // severity editor over a measurement — the exact write the owner ruled out. The
      // type has no severity to read, so this cannot be forgotten silently.
      if (!isLoggedSymptomSeries(symptom)) continue;
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
    // Exact-once display projection for overlapping open episodes. Domain status,
    // school-return, stale, and reconciliation continue to use the canonical episodes.
    presentationEpisodes?: readonly (AssembledEpisode & { id: number })[];
  }
): Map<number, DashboardIllnessCockpitModel> {
  const out = new Map<number, DashboardIllnessCockpitModel>();
  if (episodes.length === 0) return out;
  const date = today(profileId);
  const timeZone = getTimezone(profileId);
  const now = options.now ?? clockNow();
  const nowIso = now.toISOString();
  const school = schoolReturnStatusesFor(profileId, episodes, now.getTime());
  const presentationById = new Map(
    (options.presentationEpisodes ?? episodes).map((episode) => [
      episode.id,
      episode,
    ])
  );

  let sharedControls: Omit<
    DashboardIllnessControls,
    | "altDate"
    | "staleNudge"
    | "medReconciliation"
    | "initial"
    | "initialAlt"
    | "initialNotes"
    | "initialAltNotes"
  > | null = null;
  let staleAcked = new Set<number>();
  let reconciliations = new Map<number, EpisodeMedSuggestion[]>();
  if (options.canWrite) {
    sharedControls = {
      prnMeds: getPrnMedicationsForQuickLog(profileId),
      intakeOptions: getIntakeCatalogOptions(profileId),
      intakeForm: loadIntakeFormContext(profileId, options.weightUnit),
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
    const presentation = presentationById.get(episode.id) ?? episode;
    const schoolStatus = school.get(episode.id) ?? null;
    const alternate = options.canWrite
      ? (episodeAlternateLogDate(episode.ongoing, episode.firstDay, date) ??
        undefined)
      : undefined;
    const currentRecords = dayRecords([presentation], date);
    const alternateRecords = alternate
      ? dayRecords([presentation], alternate)
      : undefined;
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
      feverFree:
        schoolStatus &&
        presentation.temperatures.some(
          (temperature) => temperature.flag === "high"
        )
          ? {
              label: schoolReturnCompactLabel(
                schoolStatus,
                options.temperatureUnit
              ),
              met: schoolStatus.met,
              clearedForHours: schoolStatus.clearedForHours,
              thresholdHours: schoolStatus.thresholdHours,
            }
          : null,
      controls: sharedControls
        ? {
            ...sharedControls,
            altDate: alternate,
            initial: currentRecords.initial,
            initialNotes: currentRecords.notes,
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
