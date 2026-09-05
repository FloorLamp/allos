// The DB gather behind the pure card model in `lib/household.ts` — the same relationship
// `lib/queries/household-setup.ts` has with `lib/household-setup.ts`.
//
// NO NEW SQL LIVES HERE. Every fact is asked through the reader its own domain already
// owns, so each statement behind this module is already profile-scoped and the card
// cannot disagree with the surfaces it reports on. `lib/household.ts` stays pure: it is
// handed the raw results, and this module is the fetching half its header describes.

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
  const activeItemById = new Map(
    getIntakeItems(profileId)
      .filter((item) => item.active)
      .map((item) => [item.id, item])
  );
  // NOTHING TO SCORE, NOTHING TO GATHER (#5306 falsifying pass, third round, cost).
  // The situation resolver reads a profile's whole derived history — measured at ~8ms
  // against ~24µs for the rest of this function — and `/household` pays it once per
  // CARD. A member with no active intake item has no dose for a situation to hold or
  // trigger, so that gather can only ever produce `{0, 0}`: a growth-tracked child or
  // an unfinished profile in a caregiver's list was paying eight milliseconds for an
  // answer that is fixed. Returning here is both the cheaper and the smaller code.
  if (activeItemById.size === 0) return { taken: 0, due: 0 };
  return intakeAdherenceToday(
    getIntakeDoses(profileId),
    activeItemById,
    {
      date,
      isWorkoutDay: getActivitiesByDate(profileId, date).length > 0,
      activeSituations: getEffectiveActiveSituations(profileId, date),
    },
    getTakenDoseIds(profileId, date)
  );
}
