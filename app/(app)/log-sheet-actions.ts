"use server";

import { requireSession } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { writeSubjectName } from "@/lib/own-profile";
import { currentFoodSlot, collectDueDosesNow } from "@/lib/queries";
import { getUsualRoutineOffer } from "@/lib/queries/usual-routine";
import { foodGroupName } from "@/lib/food-groups";
import { usualRoutineFoodMembers } from "@/lib/usual-routine";
import type { UsualRoutineControlProps } from "@/components/dashboard/UsualRoutineControl";

// The log sheet's "Due & usual now" row (issue #2651) — its DATA half.
//
// ── EVERY CHIP IS AN EXISTING OFFER, RE-HOMED ────────────────────────────────
//
// Nothing here observes anything, decides anything, or opens a second opinion
// about state. The two server-resolved chips are the two offers the dashboard
// already renders, gathered again for a different mount:
//
//   • the composed morning one-tap (#2458) — `getUsualRoutineOffer`, whose food
//     half IS `usualFoodOffer`'s 21-day regularity answer with its #998/#2380
//     exclusions inherited, and whose dose half is the profile's own
//     `time_of_day` declaration read back. The sheet renders the SAME
//     <UsualRoutineControl> the dashboard's usual-routine atom renders, over the
//     SAME props, so the two surfaces cannot promise different writes.
//   • doses due NOW — `collectDueDosesNow`, the arrived-slot slice of the same
//     scheduled-dose evaluation Household and Upcoming read, already filtered
//     through the shared findings-suppression bus. The chip carries the SAME
//     items' titles and opens that same overlay; it confirms nothing itself.
//
// The third chip (an active or likely session) needs no server read at all: the
// shell already resolves `workoutOffer` (lib/workout-offer.ts) into the activity
// editor context, and the sheet reads it there — one derivation, a fourth
// renderer.
//
// ── GATHERED ON OPEN, WHICH IS WHAT MAKES A STALE TAP IMPOSSIBLE ─────────────
//
// Same discipline, same reason, as `loadQuickEntry` (#1468): a layout-time
// snapshot is exactly as stale as the page, and a dose confirmed from Telegram or
// a breakfast logged on another device between page load and puck tap must not
// still be offered here. The chips are re-derived on EVERY open. And the offer's
// own write core re-derives the bundle a second time server-side and writes only
// the intersection (#2380/#2419), so even a sheet left open through a
// cross-device write refuses rather than logging a second breakfast.
//
// READ-ONLY. It gathers props; every write still goes through the control's own
// gated Server Action (`logUsualRoutine` / `markTaken`), which is why
// login-scoped `requireSession()` is the right gate here — the same posture as
// `loadQuickEntry`, and allowlisted as such in
// lib/__tests__/actions-write-access.test.ts.

export interface LogSheetContext {
  /**
   * The composed "your usual <window>" offer, or null when it does not stand
   * (no food habit for this window, everything already logged, read-only
   * access). Null means NO CHIP — never a disabled one.
   */
  routine: UsualRoutineControlProps | null;
  /**
   * Doses whose scheduled slots have arrived and which remain unresolved. An
   * empty list means no chip; item ids let the label name each item once (#3914).
   */
  dueDoses: { items: { itemId: number; name: string }[] };
}

export async function loadLogSheetContext(): Promise<LogSheetContext> {
  const { profile, access } = await requireSession();
  const date = today(profile.id);

  // Read-only access renders no offer at all. `logUsualRoutine` gates on
  // requireWriteAccess regardless, so this is presentation rather than security —
  // but offering a caregiver-view a control that can only refuse is worse than
  // offering nothing (the dashboard's own rule, #2458).
  const offer =
    access === "write"
      ? getUsualRoutineOffer(profile.id, currentFoodSlot(profile.id), date)
      : null;

  let routine: UsualRoutineControlProps | null = null;
  if (offer) {
    // Whose morning this logs (#1013) — resolved through the same
    // scope + writeSubjectName pair the app shell uses, so a caregiver acting on
    // another profile is never ambiguous about the subject of the tap.
    const scope = await requireScope();
    routine = {
      window: offer.window,
      food: usualRoutineFoodMembers(offer, foodGroupName),
      proteinGrams: offer.proteinGrams,
      doses: offer.doses.map((d) => ({
        id: d.doseId,
        name: d.name,
        stack: d.stack ?? null,
      })),
      subjectName: writeSubjectName(
        scope.ownProfileId,
        scope.actingProfileId,
        scope.profiles.find((p) => p.id === scope.actingProfileId)?.name ??
          profile.name
      ),
    };
  }

  const nowHhmm = zonedDateParts(getTimezone(profile.id), clockNow()).hhmm;
  const dueDoses = collectDueDosesNow(profile.id, date, nowHhmm);

  return {
    routine,
    dueDoses: {
      // #2853's curated CONTROL labels; full titles remain in the overlay rows.
      items: dueDoses.map((dose) => ({
        itemId: dose.itemId,
        name: dose.shortLabel,
      })),
    },
  };
}
