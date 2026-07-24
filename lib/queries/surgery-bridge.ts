// The DB gather behind the pre-surgery / post-op suggestion bridge (issue #1299).
// Profile-scoped: reads the profile's still-scheduled appointments (the producer),
// its active situations, its intake pause links (for the held-count copy), and the
// findings-suppression bus (per-procedure dismissals). Pure decision lives in
// lib/surgery-bridge.ts; this layer only gathers state and applies the dismissal
// filter, so the surfaces (situations bar, check-in) render a formatter over it.

import { today } from "../db";
import { getScheduledAppointments } from "./appointments";
import { getActiveSituations } from "../settings/profile-attrs";
import { getFindingSuppressions } from "./upcoming/suppressions";
import {
  surgeryBridgeSuggestion,
  surgeryBridgeDismissKey,
  situationForPhase,
  sameSituationActive,
  BUILTIN_PRESURGERY_SITUATION,
  BUILTIN_POSTOP_SITUATION,
  type SurgeryBridgeSuggestion,
} from "../surgery-bridge";
import { heldBySituation } from "../supplement-schedule";
import { getSupplements } from "./intake/schedule";

// One surgery-bridge suggestion enriched for the surface: the pure decision plus the
// COUNT of active intake items the target situation would hold (#1296 — "3 items will
// be held" / "3 items resume"), the situation to activate, and the dismissal key.
export interface SurgeryBridgeCard {
  suggestion: SurgeryBridgeSuggestion;
  // The situation the accept action activates (Pre-surgery for "pre", Post-op for
  // "post").
  activateSituation: string;
  // How many active intake items link Pre-surgery as their pause situation — the
  // held-count the chip copy carries (drawn from the actual #1296 links, not a guess).
  heldCount: number;
  dismissKey: string;
}

// Count active intake items whose pause_situation is Pre-surgery — the "N items will be
// held" / "N items resume" figure. Reads the same pause link the dueness engine reads.
function presurgeryHeldCount(profileId: number): number {
  const presurgery = new Set([BUILTIN_PRESURGERY_SITUATION]);
  return getSupplements(profileId).filter(
    (s) => !!s.active && !!heldBySituation(s, presurgery)
  ).length;
}

// The profile's active surgery-bridge suggestions (issue #1299), dismissed rows
// filtered out. Each still-scheduled appointment with a surgical title is run through
// the pure window decision; a live suggestion is enriched with the held-count and its
// dismissal key. Profile-scoped throughout.
export function getSurgeryBridgeSuggestions(
  profileId: number
): SurgeryBridgeCard[] {
  const td = today(profileId);
  const active = getActiveSituations(profileId);
  const presurgeryActive = sameSituationActive(
    active,
    BUILTIN_PRESURGERY_SITUATION
  );
  const postopActive = sameSituationActive(active, BUILTIN_POSTOP_SITUATION);
  const suppressions = getFindingSuppressions(profileId);
  const heldCount = presurgeryHeldCount(profileId);

  const cards: SurgeryBridgeCard[] = [];
  for (const appt of getScheduledAppointments(profileId)) {
    if (!appt.title) continue;
    const suggestion = surgeryBridgeSuggestion(
      {
        visitId: appt.id,
        title: appt.title,
        scheduledDate: appt.scheduled_at.slice(0, 10),
      },
      td,
      { presurgery: presurgeryActive, postop: postopActive }
    );
    if (!suggestion) continue;
    const dismissKey = surgeryBridgeDismissKey(
      suggestion.phase,
      suggestion.visitId
    );
    const sup = suppressions.get(dismissKey);
    // A dismissed (indefinitely) or still-snoozed suggestion is held out.
    if (
      sup &&
      (sup.dismissed_at || (sup.snooze_until && sup.snooze_until > td))
    )
      continue;
    cards.push({
      suggestion,
      activateSituation: situationForPhase(suggestion.phase),
      heldCount,
      dismissKey,
    });
  }
  return cards;
}
