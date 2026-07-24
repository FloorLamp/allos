// The GATHER half of the check-in Calm-scale relevance gate (issue #1313): resolve
// the six OR'd signals for the active profile and hand them to the pure decision
// (anxietyScaleRelevant, lib/mood-anxiety-gate.ts). Cheap by construction — two
// EXISTS probes plus the shared safety-context/conditions/protocols reads the card
// already has, once per dashboard render. Profile-scoped through every underlying
// read (the medical_records probe filters by profile_id; getConditions/
// getIntakeSafetyContext/getProtocols are all profile_id-filtered), so no new
// un-scoped SQL.
//
// SENSITIVITY (#716 law): this resolves a per-render DISPLAY BIT. Nothing here writes
// a "mental-health-relevant" label anywhere, and the caller must never render copy
// that names which signal fired — the scale simply appears or doesn't.

import { db } from "../db";
import {
  anxietyScaleRelevant,
  ANXIETY_INSTRUMENT_CANONICAL,
  ANXIETY_PROTOCOL_OUTCOME_KEYS,
} from "../mood-anxiety-gate";
import { getConditions } from "./clinical";
import { getIntakeSafetyContext } from "./intake";
import { getProtocols } from "./protocols";
import { hasPriorAnxietyLog } from "./mood";
import { getAnxietyScaleOptIn } from "../settings/notifications";

const ANXIETY_OUTCOME_SET = new Set<string>(ANXIETY_PROTOCOL_OUTCOME_KEYS);

// Whether the check-in Calm (anxiety) scale is relevant for the active profile (the
// #1313 gate). The scale is shown iff at least one of the six signals holds.
export function isAnxietyScaleRelevant(profileId: number): boolean {
  // 1. Prior use — any prior anxiety rating (via the mood store's own read layer, so
  //    the mood store stays private). Continuity trumps inference: a
  //    profile that has ever used the scale keeps it forever.
  const priorUse = hasPriorAnxietyLog(profileId);

  // 2. Instrument on record — a GAD-7 or PHQ-9 medical_records row (#716; scores are
  //    stored biomarker-shaped under those canonical names).
  const instrumentOnRecord =
    db
      .prepare(
        `SELECT 1 FROM medical_records
           WHERE profile_id = ?
             AND canonical_name IN (${ANXIETY_INSTRUMENT_CANONICAL.map(() => "?").join(",")})
           LIMIT 1`
      )
      .get(profileId, ...ANXIETY_INSTRUMENT_CANONICAL) != null;

  // 3/4. Active conditions (curated-keyword matched in the pure gate) and active meds
  //      with their cached RxCUIs (curated-CUI matched — #144's mechanism). The med
  //      set comes from the ONE shared safety-context gather so it can't drift.
  const safety = getIntakeSafetyContext(profileId);
  const activeConditionNames = getConditions(profileId, {
    status: "active",
  }).map((c) => c.name);
  const activeMeds = safety.medications.map((m) => ({
    rxcui: m.rxcui,
    rxcuiIngredients: m.rxcuiIngredients,
  }));

  // 5. Protocol outcome — an ONGOING (end_date NULL) protocol whose primary outcome
  //    IS the anxiety series (#1259): its outcome keys include an anxiety instrument.
  const anxietyProtocolOutcome = getProtocols(profileId).some(
    (p) =>
      p.end_date == null &&
      p.outcomeKeys.some((k) => ANXIETY_OUTCOME_SET.has(k))
  );

  // 6. Explicit opt-in — the Settings → Profile toggle.
  const optIn = getAnxietyScaleOptIn(profileId);

  return anxietyScaleRelevant({
    priorUse,
    instrumentOnRecord,
    activeConditionNames,
    activeMeds,
    anxietyProtocolOutcome,
    optIn,
  });
}
