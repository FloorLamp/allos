"use server";

import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { ageInMonthsFromBirthdate, shiftDateStr } from "@/lib/date";
import { getUnitPrefs } from "@/lib/settings";
import {
  getExcludedFoodGroups,
  getUserAge,
  getUserBirthdate,
} from "@/lib/settings/profile-attrs";
import {
  showBodyFat,
  showGrowthQuickAdd,
  showHeadCircEntry,
} from "@/lib/growth-metrics";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import {
  collectHouseholdRollup,
  currentFoodSlot,
  getFoodMealDays,
  getFoodGroupLogOrder,
} from "@/lib/queries";
import { upcomingDueText } from "@/lib/upcoming";
import type { FoodGroup } from "@/lib/food-groups";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import type { TemperatureUnit, WeightUnit } from "@/lib/settings";
import type { QuickEntryForm } from "@/lib/quick-log";

// The quick-entry overlay's DATA half (issue #1468).
//
// The overlay host (components/QuickEntryProvider.tsx) is mounted on every page,
// but it must not COST anything on every page: the forms it mounts need
// server-gathered props (the food-group catalog ordered for this profile, the
// day's servings, today's due doses, unit prefs), and gathering all of that in
// the layout would tax ~60 routes for a sheet that opens on a minority of
// visits. So the props are fetched lazily, ON OPEN, through this read action —
// the SharedSupplyPicker / SyncRowsDrilldown on-open fetch pattern.
//
// Lazy is also the CORRECT freshness: a dose taken on another device (or by the
// Telegram tap) between page load and opening the sheet must not appear due
// here. A layout-time snapshot would be as stale as the page.
//
// READ-ONLY. It gathers props; every write still goes through the form's own
// existing Server Action (addMeasurements / logFoodServing / markTaken), which
// carries its own write gate. `requireSession()` is therefore
// the right gate — the same posture as loadSyncRows / runGlobalSearch — and it
// is allowlisted as such in lib/__tests__/actions-write-access.test.ts.

// One serializable dose row for the overlay's today's-due list. Deliberately
// NARROW: the full UpcomingItem carries hrefs, reasons and suppression policy the
// list has no use for, and a wide payload over the action boundary is cost paid
// on every open.
export interface QuickEntryDose {
  doseId: number;
  title: string;
  detail: string | null;
  dueText: string;
}

export type QuickEntryData =
  | {
      // ONE combined form since #1486 (weight + vitals + a minor's growth fields),
      // so the overlay gathers ONE prop set instead of two.
      form: "measurements";
      defaultDate: string;
      weightUnit: WeightUnit;
      temperatureUnit: TemperatureUnit;
      showBodyFat: boolean;
      showGrowth: boolean;
      showHeadCirc: boolean;
    }
  | {
      form: "food";
      today: string;
      days: Array<{
        date: string;
        label: string;
        counts: Record<string, number>;
        slotCounts: Record<FoodSlot, Record<string, number>>;
      }>;
      groupsBySlot: Record<FoodSlot, FoodGroup[]>;
      excludedGroups: string[];
      slot: FoodSlot;
    }
  | { form: "dose"; doses: QuickEntryDose[] }
  // A form that has nothing to offer this profile right now — an infant profile
  // has no adult food-group catalog (#591), and "no doses due" is a real answer,
  // not an empty list to stare at. Carrying it as a VARIANT keeps the host from
  // inventing per-form emptiness rules.
  | { form: "unavailable"; message: string };

export async function loadQuickEntry(
  form: QuickEntryForm
): Promise<QuickEntryData> {
  const { login, profile } = await requireSession();
  const date = today(profile.id);

  if (form === "measurements") {
    const age = getUserAge(profile.id);
    const birthdate = getUserBirthdate(profile.id);
    const prefs = getUnitPrefs(login.id);
    return {
      form: "measurements",
      defaultDate: date,
      weightUnit: prefs.weightUnit,
      temperatureUnit: prefs.temperatureUnit,
      // #493: body fat isn't tracked for a growth-tracked profile, and the page
      // mount hides the field — the overlay asks the SAME questions (the same
      // lib/growth-metrics gates) so the two mounts of one component can't
      // disagree about what's enterable.
      showBodyFat: showBodyFat(age),
      showGrowth: showGrowthQuickAdd(age),
      showHeadCirc: showHeadCircEntry(
        birthdate ? ageInMonthsFromBirthdate(birthdate, date) : null
      ),
    };
  }

  if (form === "food") {
    // The same gate the Food tab applies server-side (#591): below one year the
    // adult food-group catalog is meaningless, so say so instead of rendering an
    // empty logger.
    if (!isFoodLoggingRelevant(getUserAge(profile.id))) {
      return {
        form: "unavailable",
        message:
          "Food-group serving logging starts after the first year. Growth for this age lives in the Body and Timeline views.",
      };
    }
    const yesterday = shiftDateStr(date, -1);
    const days = getFoodMealDays(profile.id, [date, yesterday]).map((day) => ({
      ...day,
      label: day.date === date ? "Today" : "Yesterday",
    }));
    // The SAME slot derivation that orders the catalog, so the bar's slot chip
    // and its row order agree here exactly as they do on the page (#950).
    const slot = currentFoodSlot(profile.id);
    return {
      form: "food",
      today: date,
      days,
      groupsBySlot: Object.fromEntries(
        FOOD_SLOTS.map((meal) => [meal, getFoodGroupLogOrder(profile.id, meal)])
      ) as Record<FoodSlot, FoodGroup[]>,
      excludedGroups: getExcludedFoodGroups(profile.id),
      slot,
    };
  }

  // Doses. `collectHouseholdRollup` is the EXISTING "what's due" computation —
  // the one the household card and the medications strip read, already filtered
  // through the shared findings-suppression bus — so the overlay can't grow a
  // second opinion about which doses are due (the one-question-one-computation
  // rule; a hand-rolled query here is exactly how the #221 workout-nudge split
  // happened).
  const doses = collectHouseholdRollup(profile.id, date).dueDoses.map(
    (item) => ({
      doseId: item.doseId!,
      title: item.title,
      detail: item.detail ?? null,
      dueText: upcomingDueText(item, date),
    })
  );
  if (doses.length === 0) {
    return { form: "unavailable", message: "No doses are due right now." };
  }
  return { form: "dose", doses };
}
