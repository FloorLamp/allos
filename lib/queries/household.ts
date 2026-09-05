// The DB gather behind the pure card model in `lib/household.ts` — the same relationship
// `lib/queries/household-setup.ts` has with `lib/household-setup.ts`.
//
// NO NEW SQL LIVES HERE. Every fact is asked through the reader its own domain already
// owns, so each statement behind this module is already profile-scoped and the card
// cannot disagree with the surfaces it reports on. `lib/household.ts` stays pure: it is
// handed the raw results, exactly as its own header says.
//
// ── WHY THE SIX LINES CAME OUT OF THE PAGE (#5306 falsifying pass, second round) ──
// /household's card loop assembled this inline, so there was nothing for a test to call
// and the only guard available was a source scan of the page. Two passes ran at that
// scan and both got through it: one added a SECOND call below the pinned one, scoring
// every card partly against `profileIds[0]`'s situations, and the other satisfied its
// positive assertion with a comment naming the reader. Both shipped green through the
// whole db tier.
//
// The defect they demonstrate is a composition one — two correctly scoped readers, one
// profile's honest answer handed into another profile's context — which is a layer above
// where `profile-scoping.test.ts` and `scoping.test.ts` look, and it is not a shape a
// scan can hold. A named function is, so this is one: the subject and the day are its
// arguments, and a test that calls it pins them by behaviour.

import { getActivitiesByDate } from "./training/activities";
import { getIntakeItems, getIntakeDoses } from "./intake/schedule";
import { getTakenDoseIds } from "./intake/adherence";
import { getEffectiveActiveSituations } from "./derived-situations";
import { intakeAdherenceToday, type Adherence } from "../household";

/**
 * One member's x/y intake adherence for one day: how many of that day's due doses have
 * been logged.
 *
 * Dueness is `doseDueOn` through the shared pure helper, against the SAME effective
 * situation set (declared ∪ derived, dated) every other dueness surface reads — so a
 * card cannot count a dose the member's own medications page holds for a derived pause,
 * or miss one whose `situational` trigger the app derived rather than the person
 * declaring (#5167).
 *
 * Auth-blind and `profileId`-first, like every other reader in this layer: the page
 * resolves the accessible set once and calls this per member.
 */
export function intakeAdherenceOn(profileId: number, date: string): Adherence {
  return intakeAdherenceToday(
    getIntakeDoses(profileId),
    new Map(
      getIntakeItems(profileId)
        .filter((item) => item.active)
        .map((item) => [item.id, item])
    ),
    {
      date,
      isWorkoutDay: getActivitiesByDate(profileId, date).length > 0,
      activeSituations: getEffectiveActiveSituations(profileId, date),
    },
    getTakenDoseIds(profileId, date)
  );
}
