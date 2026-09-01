"use server";

import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { today } from "@/lib/db";
import { shiftDateStr, zonedDateParts } from "@/lib/date";
import { getTimezone, getUnitPrefs } from "@/lib/settings";
import { now as clockNow } from "@/lib/clock";
import {
  getExcludedFoodGroups,
  getProfileAge,
} from "@/lib/settings/profile-attrs";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import { getForecastSuspension, listCyclePeriods } from "@/lib/cycle-store";
import {
  cycleControlState,
  type CycleControlState,
} from "@/lib/cycle-plausibility";
import {
  collectDueDosesNow,
  currentFoodSlot,
  getFoodMealDays,
  type FoodMealEvent,
  getFoodBarOrder,
  getMoodOnDate,
  getPrnMedicationsForQuickLog,
  getProteinDailyGrams,
  getProteinQuickAddPreset,
  getTrackedPractices,
  type TrackedPractice,
  type PrnMedForQuickLog,
} from "@/lib/queries";
import { MOOD_LOG_DATE_WINDOW_DAYS } from "@/lib/mood";
import { doseLogDays } from "@/lib/dose-log-window";
import { TIME_BUCKETS, type TimeBucket } from "@/lib/intake-schedule";
import { formatWeekdayDate } from "@/lib/format-date";
import type { TimeFormat } from "@/lib/format-date";
import {
  pendingDayDoses,
  type PendingDayDose,
} from "@/lib/queries/usual-routine";
import { upcomingDueText } from "@/lib/upcoming";
import { getDisplayFormatPrefs } from "@/lib/settings/display";
import type { FoodGroup } from "@/lib/food-groups";
import {
  FOOD_SLOTS,
  type FoodSlot,
  type FoodSlotBoundaries,
} from "@/lib/food-slot";
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import type { TemperatureUnit } from "@/lib/settings";
import type { QuickEntryForm } from "@/lib/quick-log";
import { getBristolReadings } from "@/lib/queries/bristol-stool";
import {
  getLoggedSubstanceKeys,
  getSubstanceWeekState,
} from "@/lib/queries/substance";
import { capProgressLine, substanceDef } from "@/lib/substance-use";
import { isMinor } from "@/lib/life-stage";
import { isTaskConfigured } from "@/lib/ai-resolve";
import { getIllnessSituations } from "@/lib/settings/profile-attrs";
import {
  getCustomSymptomNames,
  getSymptomLogOrder,
  getSymptomNotesOnDate,
  getSymptomSeveritiesOnDate,
} from "@/lib/queries/symptoms";
import { closeAbandonedPracticeSessions } from "@/lib/practice-log";

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
// It also serves the COMMAND PALETTE's practice list (#1633): the palette needs the
// same finite tracked-practice set to recognize `log sauna` client-side, and a second
// gather for it would be a second opinion about which practices a quick surface offers.
// One action, one answer, both surfaces.
//
// READ-ONLY. It gathers props; every write still goes through the form's own
// existing Server Action (addMeasurements / logFoodServing / markTaken /
// logPractice / logSymptom / activateIllnessForSymptoms / uploadMedicalDocument), which
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

export interface QuickEntryPrn {
  meds: PrnMedForQuickLog[];
  tz: string;
  timeFormat: TimeFormat;
  nowIso: string;
}

// One recent-past day the dose sheet can switch to, with what it still owes grouped
// by the bucket each dose was DECLARED in. A past day is NOT filtered by arrived
// slot — every bucket of a closed day has arrived — so this is the day's whole
// unresolved set, which is also exactly what the per-bucket bulk row writes.
export interface QuickEntryPastDay {
  date: string;
  // "Yesterday", or the weekday+date in the reader's own format prefs.
  label: string;
  slots: {
    bucket: TimeBucket;
    doses: QuickEntryPastDose[];
  }[];
}

// A past day's unresolved dose. `stack` (#3098) feeds the shared label compression
// the bulk row promises with; nothing here is a second dueness derivation.
export interface QuickEntryPastDose {
  doseId: number;
  name: string;
  detail: string | null;
  stack: string | null;
}

// NOT the measurements form. It is the one quick-write surface a person is
// expected to reach with NO CONNECTION (#4091), and a Server Action rejects
// offline — so its props are resolved in the app shell and handed to the overlay
// host as a prop instead (lib/quick-entry-measurements.ts states why, and what
// freshness that costs).
export type QuickEntryData =
  | {
      form: "food";
      today: string;
      days: Array<{
        date: string;
        label: string;
        counts: Record<string, number>;
        slotCounts: Record<FoodSlot, Record<string, number>>;
        // The day's individual servings — the ⋯ correction rows (#1934), carried
        // through so the quick-log sheet offers the same repair the page does.
        events: FoodMealEvent[];
      }>;
      groupsBySlot: Record<FoodSlot, FoodGroup[]>;
      // Where the protein pseudo-entry ranked per meal (#1980), or null for a profile
      // that doesn't track protein — the sheet then renders no protein control at all.
      // The full Food tab stays the complete surface (the attention doctrine's class-3
      // completeness), so nothing is lost: this compact overlay just doesn't offer a
      // gram box to someone with no scoop size to re-offer.
      proteinRankBySlot: Record<FoodSlot, number | null>;
      // Today's manual-protein total + the last-used amount, for the ranked protein
      // control. Null preset ⇒ untracked ⇒ no control (proteinRankBySlot is all null).
      proteinToday: number;
      proteinPreset: number | null;
      excludedGroups: string[];
      slot: FoodSlot;
      // The profile's meal-window boundaries — what the correction sheet's
      // follow-the-hour Meal default derives from (#2227 d4), the same numbers the
      // server's tallies use.
      slotBoundaries: FoodSlotBoundaries;
    }
  | {
      form: "dose";
      // The acting profile's today (YYYY-MM-DD) — the day the switcher opens on and
      // the anchor its other two days are shifted from.
      today: string;
      // TODAY's offer, unchanged: the arrived-slot due-now slice. An evening dose is
      // still not "due right now" in the morning.
      doses: QuickEntryDose[];
      prn: QuickEntryPrn;
      // The recent-past days the sheet may switch to (#3936), newest first — exactly
      // `doseLogDays(today)` minus today, so the switcher offers precisely the window
      // the write cores accept. A day with nothing left to log is still LISTED (with
      // an empty `slots`): the switcher's job is to say what the window is, and a day
      // that silently disappeared would read as "there is nothing back there" when
      // the truth is "that day is already settled".
      pastDays: QuickEntryPastDay[];
    }
  | {
      // The tracked practices, each with the standing the shared card shows (#1633).
      // Plain rows, not a second opinion: they come from the same weekly-progress
      // computation the Wellness page reads.
      form: "practice";
      practices: TrackedPractice[];
      // The acting profile's today (YYYY-MM-DD): the row's log button asks a
      // day-scoped question before a second session (#2007 layer 3).
      today: string;
    }
  | {
      // The ONE cycle offer state (#1892) — the same `cycleControlState` the Cycle
      // page control and dashboard control atom render, resolved here so the
      // overlay's button decides nothing. Gathered ON OPEN, which is the only way
      // the sheet's verb can be current: a layout-time snapshot would be exactly as
      // stale as the page it rode in on.
      form: "cycle";
      state: CycleControlState;
    }
  | {
      // The daily check-in (#2130), with the #2128 backfill window: today first,
      // then each earlier day the chips may pick, each with its already-logged
      // check-in so the face row mirrors the selected day. Gathered ON OPEN so a
      // sheet opened after midnight can't offer yesterday's "today".
      form: "mood";
      days: {
        date: string;
        mood: {
          valence: number;
          energy: number | null;
          anxiety: number | null;
          factors: string[];
          notes: string | null;
        } | null;
      }[];
    }
  | {
      // The well-day symptom bar (#4064) — the SAME props the dashboard's own mount
      // passes, gathered on OPEN. Narrow on purpose: the curated catalog is a pure
      // constant the panel imports (`PICKER_SYMPTOMS`), so only the per-profile,
      // per-day half crosses the action boundary.
      form: "symptom";
      // The acting profile's today — the day every tap files under.
      today: string;
      // symptom key -> severity / note already logged today, so the bar opens showing
      // the day's working set rather than an empty one.
      severities: Record<string, number>;
      notes: Record<string, string>;
      customNames: string[];
      rankedKeys: string[];
      temperatureUnit: TemperatureUnit;
      textIntakeEnabled: boolean;
      // The illness verb, RESOLVED (docs/internals/stateful-affordances.md): the
      // situations currently flagged illness-type and active, or an empty list when
      // there are none. Empty means the bar offers its bridge; non-empty means the
      // panel names what is already tracked instead, so the sheet never offers to
      // start something that is already running.
      trackingIllness: string[];
    }
  | {
      // Nothing to gather for the upload form beyond the demo gate the Data page
      // applies to its own mount (#1525) — the files come from the user, and every
      // size/type/dedup rule lives server-side in the ingest engine.
      form: "document";
      demo: boolean;
    }
  // A form that has nothing to offer this profile right now — an infant profile
  // has no adult food-group catalog (#591), and "no doses due" is a real answer,
  // not an empty list to stare at. Carrying it as a VARIANT keeps the host from
  // inventing per-form emptiness rules.
  | {
      // Bristol stool form (#2785). The picker needs nothing gathered but the day's
      // running count — the seven types are a committed vocabulary, not server state.
      form: "stool";
      todayCount: number;
      // The acting profile's today — the day a tap files under, and the day the
      // sheet's "Happened earlier?" statement is anchored on (#3273).
      today: string;
    }
  | {
      // The profile's OWN substances (#3327), one tap each. Every field is resolved
      // server-side so the panel decides nothing:
      //
      //   • `label` is `substanceLabel` — the curated noun, or the person's own
      //     spelling verbatim for a custom key (#3323). Case survives to here
      //     unchanged: #3325 folds case for MATCHING at the write boundary, in both
      //     vocabularies at once, and never for display.
      //   • `logLabel` is the substance's own verb — "Log a standard drink" for
      //     alcohol, "Log a use" for everything else, curated or named.
      //   • `capProgress` is `capProgressLine` and is NULL for a substance with no
      //     target. Not "empty": there is nothing to render, because
      //     `substanceCapStatus` is only produced where a target row exists. That
      //     absence is the whole opt-in mechanism (docs/internals/substances.md) —
      //     a profile that opted into no cap can receive no cap framing here, and
      //     nothing in this payload could manufacture one.
      form: "substance";
      substances: {
        key: string;
        label: string;
        logLabel: string;
        capProgress: string | null;
      }[];
    }
  | { form: "unavailable"; message: string };

export async function loadQuickEntry(
  form: QuickEntryForm
): Promise<QuickEntryData> {
  const { login, profile } = await requireSession();
  const date = today(profile.id);

  if (form === "food") {
    // The same gate the Food tab applies server-side (#591): below one year the
    // adult food-group catalog is meaningless, so say so instead of rendering an
    // empty logger.
    if (!isFoodLoggingRelevant(getProfileAge(profile.id))) {
      return {
        form: "unavailable",
        message:
          "Food-group serving logging starts after the first year. Growth for this age lives in the Body and History views.",
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
    // THE ranking (#1980) — the same call the Food tab and the Telegram nudge make, so
    // the sheet can never offer a different order than the page it opened over.
    const orderBySlot = Object.fromEntries(
      FOOD_SLOTS.map((meal) => [meal, getFoodBarOrder(profile.id, meal)])
    ) as Record<FoodSlot, ReturnType<typeof getFoodBarOrder>>;
    return {
      form: "food",
      today: date,
      days,
      groupsBySlot: Object.fromEntries(
        FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].groups])
      ) as Record<FoodSlot, FoodGroup[]>,
      proteinRankBySlot: Object.fromEntries(
        FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].proteinRank])
      ) as Record<FoodSlot, number | null>,
      proteinToday: getProteinDailyGrams(profile.id, date),
      proteinPreset: getProteinQuickAddPreset(profile.id),
      excludedGroups: getExcludedFoodGroups(profile.id),
      slot,
      slotBoundaries: profileFoodSlotBoundaries(profile.id),
    };
  }

  if (form === "stool") {
    return {
      form: "stool",
      todayCount: getBristolReadings(profile.id, date, date).length,
      today: date,
    };
  }

  if (form === "practice") {
    closeAbandonedPracticeSessions(profile.id);
    // The tracked-practice list (a practice-scope frequency target IS the user's
    // declaration that they mean to keep doing it).
    //
    // AN EMPTY LIST IS NOT AN `unavailable` (#3066). It used to be: the answer was
    // "add one under Wellness", which named a page whose nav row the #1620 gate hides
    // until a practice exists — the only creation path sat behind a gate that
    // requires what it creates, so a profile that had never tracked one could reach
    // practices only by typing the URL. The gate is right and stays; the zero-state
    // answer becomes the offer itself, which is #1633's own argument continued (this
    // row exists because "the web app made you find /wellness first"). The empty list
    // IS the bootstrap state, so it is a `practice` payload and the list component
    // renders the create form in it.
    return {
      form: "practice",
      practices: getTrackedPractices(profile.id, date),
      today: date,
    };
  }

  if (form === "substance") {
    // Re-gated server-side on the SAME two facts the sheet row is gated on, so a
    // hand-written `?quick=log-substance` deep link cannot reach the offer: the #1174
    // adult gate the whole substance surface carries, and data presence. A profile
    // that tracks none gets no ROW at all (lib/quick-log.ts) — this branch is what
    // answers the deep link that skipped the row.
    if (isMinor(getProfileAge(profile.id))) {
      return {
        form: "unavailable",
        message: "This isn't available for this profile.",
      };
    }
    const keys = getLoggedSubstanceKeys(profile.id);
    if (keys.length === 0) {
      return {
        form: "unavailable",
        message:
          "No substances tracked yet. Name one under Health record \u2192 Specialty \u2192 Substance use to log it from here.",
      };
    }
    return {
      form: "substance",
      substances: keys.map((key) => {
        const week = getSubstanceWeekState(profile.id, key);
        return {
          key,
          label: substanceDef(key).label,
          logLabel: substanceDef(key).logLabel,
          capProgress: week.status ? capProgressLine(week.status, key) : null,
        };
      }),
    };
  }

  if (form === "cycle") {
    // Relevance-gated server-side on the SAME `cycle` bit as the sheet row, the Cycle
    // nav entry, and the dashboard presentation — so a hand-written `?quick=log-period` deep
    // link cannot reach the offer on a profile the domain does not apply to.
    if (!getNavRelevance(profile.id).cycle) {
      return {
        form: "unavailable",
        message:
          "Cycle tracking isn't set up for this profile. Turn it on by recording a period under Medical \u2192 Cycle.",
      };
    }
    return {
      form: "cycle",
      state: cycleControlState(
        listCyclePeriods(profile.id),
        date,
        getForecastSuspension(profile.id)
      ),
    };
  }

  if (form === "mood") {
    // Today plus the #2128 backfill window, through the same read the dashboard
    // card's server mount uses — one gather shape, two surfaces.
    const days = Array.from(
      { length: MOOD_LOG_DATE_WINDOW_DAYS + 1 },
      (_, offset) => {
        const day = offset === 0 ? date : shiftDateStr(date, -offset);
        const logged = getMoodOnDate(profile.id, day);
        return {
          date: day,
          mood: logged
            ? {
                valence: logged.valence,
                energy: logged.energy,
                anxiety: logged.anxiety,
                factors: logged.factors,
                notes: logged.notes,
              }
            : null,
        };
      }
    );
    return { form: "mood", days };
  }

  if (form === "symptom") {
    // The dashboard's well-day card reads exactly these (app/(app)/page.tsx), and the
    // panel passes them to the same component — so the sheet mount and the dashboard
    // mount post byte-identical payloads apart from the surface each declares
    // (components/__tests__/quick-symptom-parity.test.tsx holds the two together).
    return {
      form: "symptom",
      today: date,
      severities: getSymptomSeveritiesOnDate(profile.id, date),
      notes: getSymptomNotesOnDate(profile.id, date),
      customNames: getCustomSymptomNames(profile.id),
      rankedKeys: getSymptomLogOrder(profile.id),
      temperatureUnit: getUnitPrefs(login.id).temperatureUnit,
      textIntakeEnabled: isTaskConfigured("symptom-map"),
      trackingIllness: getIllnessSituations(profile.id)
        .filter((s) => s.active)
        .map((s) => s.name),
    };
  }

  if (form === "document") {
    // Demo mode (#181): the Data page disables its upload input for a restricted login,
    // and this mount of the SAME form asks the same question — the write is already
    // refused server-side; this is the UX on top.
    return {
      form: "document",
      demo: isDemoRestricted(isDemoMode(), login.role),
    };
  }

  // Doses. The overlay and its context chip read the SAME arrived-slot slice of
  // the shared scheduled-dose evaluation, so an evening dose cannot be called
  // "due right now" in the morning while Household/Upcoming retain their honest
  // whole-day view.
  const tz = getTimezone(profile.id);
  const now = clockNow();
  const nowHhmm = zonedDateParts(tz, now).hhmm;
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const prnMeds = getPrnMedicationsForQuickLog(profile.id);
  const doses = collectDueDosesNow(profile.id, date, nowHhmm).map((item) => ({
    doseId: item.doseId!,
    title: item.title,
    detail: item.detail ?? null,
    // Every dose here is due TODAY, so the band-aware fallback (#2579-B) never
    // reaches its calendar-date arm — the prefs are passed because a formatter that
    // CAN render a date is called with the reader's shape, not because this one does.
    dueText: upcomingDueText(item, date, formatPrefs),
  }));
  // The recent past (#3936). `doseLogDays` reads DOSE_LOG_DATE_WINDOW_DAYS, the same
  // constant the write cores gate on, so the offer and the gate cannot drift; `date`
  // is already the profile-LOCAL today, so each shifted day is a profile-local day.
  const pastDays = doseLogDays(date)
    .slice(1)
    .map((day, back) => ({
      date: day,
      label: back === 0 ? "Yesterday" : formatWeekdayDate(day, formatPrefs),
      slots: groupDosesByBucket(pendingDayDoses(profile.id, day)),
    }));
  if (
    doses.length === 0 &&
    prnMeds.length === 0 &&
    pastDays.every((day) => day.slots.length === 0)
  ) {
    return { form: "unavailable", message: "No doses are due right now." };
  }
  return {
    form: "dose",
    today: date,
    doses,
    prn: {
      meds: prnMeds,
      tz,
      timeFormat: formatPrefs.timeFormat,
      nowIso: now.toISOString(),
    },
    pastDays,
  };
}

// A day's unresolved doses in declared-bucket order, empty buckets dropped. The order
// is TIME_BUCKETS' own, so a day reads down the clock the way the schedule does.
function groupDosesByBucket(
  pending: readonly PendingDayDose[]
): QuickEntryPastDay["slots"] {
  return TIME_BUCKETS.map((bucket) => ({
    bucket,
    doses: pending
      .filter((dose) => dose.bucket === bucket)
      .map((dose) => ({
        doseId: dose.doseId,
        name: dose.name,
        detail: dose.detail,
        stack: dose.stack ?? null,
      })),
  })).filter((slot) => slot.doses.length > 0);
}
