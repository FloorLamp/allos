// The DB tier's persona seeding context.
//
// `scripts/seed-personas.ts` stays import-pure (type-only imports) so the unit tier can
// read the registry without booting a database; the live `db` handle and the lib helpers
// a persona writes through are therefore passed in by whoever seeds it. Every DB-tier
// spec that seeds PERSONAS needs the same object, so it is built here once rather than
// copied per spec.
//
// The four route/gather budget gates share this fixture on purpose: a tick and a render
// are then measured against the same six people. This module owns the context, not the
// clock — a spec that needs a fixed instant pins it itself (the tier freeze in
// frozen-clock.ts moves with the real day, and a persona's data is seeded relative to
// whatever `today()` says when it runs).
import { db, today, writeTx } from "@/lib/db";
import { shiftDateStr, utcInstant } from "@/lib/date";
import { zonedWallTimeToUtc } from "@/lib/calendar-ics";
import { reconcileFlags } from "@/lib/queries";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { recordGlucoseTrace } from "@/lib/glucose-trace-db";
import { getTimezone } from "@/lib/settings";
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
import { episodesForSituation } from "@/lib/symptom-episode";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import {
  completeOnboardingState,
  initialOnboardingState,
  normalizeOnboardingFocuses,
  serializeOnboardingState,
} from "@/lib/onboarding";
import type { PersonaContext } from "../../scripts/seed-personas";

export function personaContextFor(profileId: number): PersonaContext {
  const daysAgo = (n: number) => shiftDateStr(today(profileId), -n);
  return {
    db,
    profileId,
    daysAgo,
    shiftDateStr,
    occurredAt: (day, hhmm) => {
      const [y, m, d] = day.split("-").map(Number);
      const [h, min] = hhmm.split(":").map(Number);
      return utcInstant(
        zonedWallTimeToUtc(y, m, d, h, min, getTimezone(profileId))
      );
    },
    reconcileFlags,
    saveFitnessEntry: (pid, entry) => saveFitnessEntry(pid, entry, "page"),
    recordGlucoseTrace,
    seedStandardMetricSaves: (pid) => seedStandardMetricSaves(db, pid),
    writeTx,
    diffSituations,
    serializeSituationEvents,
    episodesForSituation,
    onboardingStateJson: (profilePath, focuses) =>
      serializeOnboardingState(
        completeOnboardingState(
          {
            ...initialOnboardingState(),
            profilePath,
            focuses: normalizeOnboardingFocuses(focuses),
            basicsComplete: true,
            dataReviewed: true,
            notificationIntent: "later",
            notificationsReviewed: true,
            checklistDismissed: true,
          },
          new Date().toISOString()
        )
      ),
  };
}
