// The episodes-index model (issue #856 item 9). `allEpisodesForProfile` existed but was
// consumed nowhere; this turns each stored episode row into a compact index entry —
// date range, duration, peak temp, symptom set, outcome — by formatting over the SAME
// #801 assembly every other surface uses (one question, one computation, #221). The
// annotations (note/outcome) come from the row; everything derived comes from the
// assembly. profileId-first, auth-blind.

import { listEpisodeRows, episodeRowToDerived } from "./illness-episode-store";
import { assembleIllnessEpisode } from "./illness-episode";
import { getConditions } from "./queries/clinical";

export interface EpisodeIndexEntry {
  id: number;
  situation: string;
  start: string | null; // inclusive first active day
  end: string | null; // EXCLUSIVE end (null = ongoing)
  ongoing: boolean;
  firstDay: string | null;
  lastActiveDay: string | null;
  dayCount: number | null;
  maxTempF: number | null;
  symptomLabels: string[]; // worst-first, deduped
  distinctSymptomCount: number;
  totalAdministrations: number;
  // The user-owned outcome annotation, or a derived hint (a bridged/promoted condition)
  // when unset — answering "how did it go" without forcing the user to fill it in.
  outcome: string | null;
  promotedConditionName: string | null;
}

// Every episode of a profile as an index entry, most-recent first.
export function summarizeEpisodesForProfile(
  profileId: number
): EpisodeIndexEntry[] {
  // The condition list is profile-invariant across episodes — fetch it ONCE and pass
  // it into every assembly rather than re-running its full-table window subquery per
  // episode (#886). The per-episode symptom/temperature/PRN queries genuinely vary by
  // the episode's date window and stay inside the assembly.
  const conditions = getConditions(profileId);
  return listEpisodeRows(profileId).map((row) => {
    const assembled = assembleIllnessEpisode(
      profileId,
      episodeRowToDerived(row),
      conditions
    );
    const promoted = assembled.conditions.find((c) => c.fromEpisode) ?? null;
    return {
      id: row.id,
      situation: assembled.situation,
      start: assembled.start,
      end: assembled.end,
      ongoing: assembled.ongoing,
      firstDay: assembled.firstDay,
      lastActiveDay: assembled.lastActiveDay,
      dayCount: assembled.dayCount,
      maxTempF: assembled.maxTempF,
      symptomLabels: assembled.symptoms.map((s) => s.label),
      distinctSymptomCount: assembled.distinctSymptomCount,
      totalAdministrations: assembled.totalAdministrations,
      outcome: row.outcome,
      promotedConditionName: promoted ? promoted.name : null,
    };
  });
}
