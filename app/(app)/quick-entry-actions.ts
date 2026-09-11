"use server";

import { requireSession, type CurrentSession } from "@/lib/auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { gateSubjectProfile } from "./gate-item";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { today } from "@/lib/db";
import { isRealIsoDate, shiftDateStr, zonedDateParts } from "@/lib/date";
import { getTimezone, getUnitPrefs } from "@/lib/settings";
import { now as clockNow } from "@/lib/clock";
import { getProfileAge } from "@/lib/settings/profile-attrs";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import { getForecastSuspension, listCyclePeriods } from "@/lib/cycle-store";
import {
  cycleControlState,
  type CycleControlState,
} from "@/lib/cycle-plausibility";
import {
  collectDueDosesNow,
  type FoodMealEvent,
  getAdministrationsForItemsOnDate,
  getIntakeDoses,
  getIntakeItems,
  getMoodOnDate,
  getPediatricFormContext,
  getPrnMedicationsForQuickLog,
  getTrackedPractices,
  type TrackedPractice,
  type PrnMedForQuickLog,
} from "@/lib/queries";
import { doseScheduleAsOf } from "@/lib/intake-cadence";
import { bestKnownInstant } from "@/lib/row-instants";
import { formatMedicationDoseProduct } from "@/lib/medication-dose-format";
import { doseLogDays } from "@/lib/dose-log-window";
import { TIME_BUCKETS, type TimeBucket } from "@/lib/intake-schedule";
import { formatClock, formatWeekdayDate } from "@/lib/format-date";
import type { TimeFormat } from "@/lib/format-date";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import {
  pendingDayDoses,
  type PendingDayDose,
} from "@/lib/queries/usual-routine";
import { upcomingDueText } from "@/lib/upcoming";
import { getDisplayFormatPrefs } from "@/lib/settings/display";
import type { FoodGroup } from "@/lib/food-groups";
import type { FoodSlot, FoodSlotBoundaries } from "@/lib/food-slot";
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
import { isAnxietyScaleRelevant } from "@/lib/queries/mood-anxiety";
import { isWithinReach, SHEET_REACH, TAP_REACH } from "@/lib/log-manifest";
import { gatherQuickEntryFood } from "@/lib/quick-entry-food";
import {
  loadIntakeFormContext,
  type IntakeFormContext,
} from "@/lib/intake-form-context";

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
  // The SUBJECT's pediatric dosing context (#4713) — the sheet's chosen profile, not
  // the acting one — so a child's PRN row bands from the weight on file at the tap.
  pediatric: PediatricFormContext;
}

// One recent-past day the dose sheet can switch to, with what it still owes grouped
// by the bucket each dose was DECLARED in. A past day is NOT filtered by arrived
// slot — every bucket of a closed day has arrived — so this is the day's whole
// unresolved set. The bucket is the row's CHIP PAYLOAD (#5753 leg 1), which is the
// only thing the sheet still groups for; the day's own name is the switcher's, and
// this payload stopped carrying a second spelling of it.
export interface QuickEntryPastDay {
  date: string;
  slots: {
    bucket: TimeBucket;
    doses: QuickEntryPastDose[];
  }[];
}

// A past day's unresolved dose. Nothing here is a second dueness derivation.
export interface QuickEntryPastDose {
  doseId: number;
  name: string;
  detail: string | null;
  amountAssumed: boolean;
}

// ── THE FOLD: EVERYTHING ELSE (#5808, owner ruling 2026-09-10) ───────────────
//
// One item the sheet's dose body can log that it is not otherwise showing. The body's
// three sources are all about what is OWED or offered right now — today's arrived
// slots, the as-needed medications, the recent days' unresolved doses — so an active
// item that is simply not due had no row at all: an unscheduled supplement (never due
// by #5285's ruling, and correctly so), a scheduled item wanted outside its slot, or a
// second dose of one already taken. Once #5435 moves the record's kind chips off today
// the sheet is today's only door, and those items would have none.
//
// IT IS A CATALOG SLICE, NOT A FOURTH DUENESS. Nothing here is due, nothing here
// becomes due, and the Take writes through the DATED core (`logHistoricalDose`) rather
// than resolving an occurrence — an unscheduled item HAS no occurrence, which is the
// whole reason this row exists.
export interface QuickEntryOtherItem {
  itemId: number;
  // The dose row the Take writes against: the item's FIRST live dose, by the same
  // (sort, id) order every other one-row-per-item read in this domain picks an amount
  // with (the PRN gather, the `may` offer). An item's several slots are the record
  // door's question, not this row's — the fold offers the item, once.
  doseId: number;
  name: string;
  // The usual amount ON THE SHEET'S DAY (`doseScheduleAsOf`), formatted the way the
  // offer tail formats it — the chip's payload, so the row says what a tap writes.
  detail: string | null;
  // The latest dose ALREADY logged on that day, as a profile-local clock ("8:15am"),
  // or null. An item taken this morning still lists here so a second dose is one tap.
  takenAt: string | null;
}

// The fold's offer for every day the sheet may stand on. Keyed by date because the
// body's exclusions, the day's resolved amount and the day's logs are all per-day, and
// the switcher may land on any of them without a re-gather.
export interface QuickEntryOthers {
  byDate: Record<string, QuickEntryOtherItem[]>;
  // The gather's profile-local wall minute. `logHistoricalDose` REQUIRES a stated
  // time, and the live day's one-tap Take has none to ask for — so the minute comes
  // from the SERVER's clock here, never a browser read: the sheet is a client
  // component, and lib/clock's frozen-test override does not exist in the browser.
  nowHhmm: string;
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
      // The requested day's manual-protein total + the last-used amount, for the
      // ranked protein control. Null preset ⇒ untracked ⇒ no control
      // (proteinRankBySlot is all null).
      proteinGrams: number;
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
      prn?: QuickEntryPrn;
      // The recent-past days the sheet may switch to (#3936), newest first — exactly
      // `doseLogDays(today)` minus today, so the switcher offers precisely the window
      // the write cores accept. A day with nothing left to log is still LISTED (with
      // an empty `slots`): the switcher's job is to say what the window is, and a day
      // that silently disappeared would read as "there is nothing back there" when
      // the truth is "that day is already settled".
      pastDays: QuickEntryPastDay[];
      // The fold's offer per offered day (#5808). Optional so a cached former-shape
      // response still renders — an absent fold is the zero case, which is the state
      // the ruling asks for anyway.
      others?: QuickEntryOthers;
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
      today: string;
      days: {
        date: string;
        label: string;
        mood: {
          valence: number;
          energy: number | null;
          anxiety: number | null;
          factors: string[];
          notes: string | null;
        } | null;
      }[];
      showCalm: boolean;
      // Set only by device recovery in the client host. A Server Action result has
      // seen the authoritative row and therefore always leaves this absent.
      dayUnseen?: true;
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
      // The SUBJECT's zone (#4712 item 2), needed once the panel carries the
      // temperature fold: a reading states a minute, and a minute is only a time in
      // somebody's zone. The browser's — and the acting profile's — may not be the
      // subject's, and `today` above is already resolved the same way.
      timeZone: string;
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
      today: string;
      substances: {
        key: string;
        label: string;
        logLabel: string;
        capProgress: string | null;
      }[];
    }
  | { form: "unavailable"; today: string; message: string };

export type QuickEntryLoadResult =
  | { kind: "ready"; data: QuickEntryData }
  | { kind: "refused"; reason: "session" | "subject" };

export type QuickEntryIntakeContextResult =
  | { kind: "ready"; context: IntakeFormContext }
  | { kind: "refused"; reason: "session" | "subject" };

type QuickEntrySubjectResult =
  | { kind: "ready"; session: CurrentSession; profileId: number }
  | { kind: "refused"; reason: "session" | "subject" };

async function resolveQuickEntrySubject(
  subjectProfileId?: number
): Promise<QuickEntrySubjectResult> {
  let session: CurrentSession;
  try {
    session = await requireSession();
  } catch (error) {
    if (isRedirectError(error)) return { kind: "refused", reason: "session" };
    throw error;
  }
  if (subjectProfileId != null && subjectProfileId !== session.profile.id) {
    try {
      return {
        kind: "ready",
        session,
        profileId: await gateSubjectProfile(subjectProfileId),
      };
    } catch (error) {
      if (isRedirectError(error)) return { kind: "refused", reason: "subject" };
      throw error;
    }
  }
  return { kind: "ready", session, profileId: session.profile.id };
}

export async function loadQuickEntryIntakeContext(
  subjectProfileId?: number
): Promise<QuickEntryIntakeContextResult> {
  const resolved = await resolveQuickEntrySubject(subjectProfileId);
  if (resolved.kind === "refused") return resolved;
  return {
    kind: "ready",
    context: loadIntakeFormContext(
      resolved.profileId,
      getUnitPrefs(resolved.session.login.id).weightUnit
    ),
  };
}

export async function loadQuickEntry(
  form: QuickEntryForm,
  // The sheet's chosen subject (#4932) — present when the title-row chip names
  // someone other than the acting profile. ONE GATE for it: an explicit non-acting
  // subject is write-checked exactly like a posted write is
  // (gateSubjectProfile → requireProfileWriteAccess), so a login can gather for a
  // profile no more than it could post to it. Absent or equal to the acting profile,
  // this stays the acting-profile read requireSession() below already allowed —
  // every WRITE the mounted forms post still re-gates itself through
  // gateItemProfile, which is what keeps this a read-only allowlist entry in
  // actions-write-access.test.ts.
  subjectProfileId?: number,
  selectedDay?: string,
  selectedReach: "sheet" | "dated" = "sheet"
): Promise<QuickEntryLoadResult> {
  const resolved = await resolveQuickEntrySubject(subjectProfileId);
  if (resolved.kind === "refused") return resolved;
  return {
    kind: "ready",
    data: await gatherQuickEntry(
      form,
      resolved.session,
      resolved.profileId,
      subjectProfileId,
      selectedDay,
      selectedReach
    ),
  };
}

async function gatherQuickEntry(
  form: QuickEntryForm,
  session: CurrentSession,
  profileId: number,
  subjectProfileId?: number,
  selectedDay?: string,
  selectedReach: "sheet" | "dated" = "sheet"
): Promise<QuickEntryData> {
  const { login, profile: actingProfile } = session;
  const profile = { id: profileId };
  const date = today(profile.id);
  const selectedDateReach =
    selectedReach === "dated" &&
    (form === "food" ||
      form === "mood" ||
      form === "practice" ||
      form === "symptom" ||
      form === "stool" ||
      form === "substance")
      ? ({ kind: "dated" } as const)
      : form === "dose"
        ? TAP_REACH["dose-day"]
        : SHEET_REACH;
  if (
    selectedDay != null &&
    (!isRealIsoDate(selectedDay) ||
      !isWithinReach(selectedDateReach, date, selectedDay))
  ) {
    return {
      form: "unavailable",
      today: date,
      message: "That day is outside quick logging.",
    };
  }
  const requestedDate = selectedDay ?? date;

  if (form === "food") {
    const food = gatherQuickEntryFood(profile.id, {
      loginId: login.id,
      today: date,
      requestedDate,
      now: clockNow(),
    });
    if (!food.available) {
      return {
        form: "unavailable",
        today: date,
        message:
          "Food-group serving logging starts after the first year. Growth for this age lives in the Body and History views.",
      };
    }
    return {
      form: "food",
      today: date,
      days: food.days,
      groupsBySlot: food.groupsBySlot,
      proteinRankBySlot: food.proteinRankBySlot,
      proteinGrams: food.grams,
      proteinPreset: food.preset,
      excludedGroups: food.exclusions,
      slot: food.slot,
      slotBoundaries: food.boundaries,
    };
  }

  if (form === "stool") {
    return {
      form: "stool",
      todayCount: getBristolReadings(profile.id, requestedDate, requestedDate)
        .length,
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
    //
    // #4932 invariant 2: the bootstrap CREATE (`savePractice`) is a first-class
    // definition row and, like the #4693 census found for creates generally, is not
    // yet subject-following — it always writes the ACTING profile. Rendering it for
    // a chosen non-acting subject with nothing tracked would silently create the
    // practice on the wrong person, so that one shape earns the unavailable state;
    // logging an EXISTING tracked practice does not (`logPractice` already follows
    // the subject through `gateItemProfile`).
    const practices = getTrackedPractices(profile.id, requestedDate);
    if (
      practices.length === 0 &&
      subjectProfileId != null &&
      subjectProfileId !== actingProfile.id
    ) {
      return {
        form: "unavailable",
        today: date,
        message:
          "This profile has no tracked practices yet. Switch to it to start one.",
      };
    }
    return {
      form: "practice",
      practices,
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
        today: date,
        message: "This isn't available for this profile.",
      };
    }
    const keys = getLoggedSubstanceKeys(profile.id);
    if (keys.length === 0) {
      return {
        form: "unavailable",
        today: date,
        message:
          "No substances tracked yet. Name one under Health record \u2192 Specialty \u2192 Substance use to log it from here.",
      };
    }
    return {
      form: "substance",
      today: date,
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
    // #4932 invariant 2 (full subject-keyed context, or no door): the cycle writes
    // (start/end/reopen, medical/cycles/actions.ts) are documented there as
    // DECLARATIONS BY THE ACTING PROFILE, deliberately gated on the session's active
    // profile rather than a posted subject — a different shape from a record
    // correction, and this issue does not change that shape. A chip naming someone
    // else would render a button that silently logged the WRONG person's period, so
    // the form shows the unavailable state instead of a partial, misleading one.
    if (subjectProfileId != null && subjectProfileId !== actingProfile.id) {
      return {
        form: "unavailable",
        today: date,
        message:
          "Period logging is a declaration by the profile acting — switch to this profile to log it.",
      };
    }
    // Relevance-gated server-side on the SAME `cycle` bit as the sheet row, the Cycle
    // nav entry, and the dashboard presentation — so a hand-written `?quick=log-period` deep
    // link cannot reach the offer on a profile the domain does not apply to.
    if (!getNavRelevance(profile.id).cycle) {
      return {
        form: "unavailable",
        today: date,
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
    const days = [requestedDate].map((day) => {
      const logged = getMoodOnDate(profile.id, day);
      return {
        date: day,
        label:
          day === date
            ? "Today"
            : day === shiftDateStr(date, -1)
              ? "Yesterday"
              : formatWeekdayDate(day, getDisplayFormatPrefs(login.id)),
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
    });
    return {
      form: "mood",
      today: date,
      days,
      showCalm: isAnxietyScaleRelevant(profile.id),
    };
  }

  if (form === "symptom") {
    // The dashboard's well-day card reads exactly these (app/(app)/page.tsx), and the
    // panel passes them to the same component — so the sheet mount and the dashboard
    // mount post byte-identical payloads apart from the surface each declares
    // (components/__tests__/quick-symptom-parity.test.tsx holds the two together).
    return {
      form: "symptom",
      today: date,
      severities: getSymptomSeveritiesOnDate(profile.id, requestedDate),
      notes: getSymptomNotesOnDate(profile.id, requestedDate),
      customNames: getCustomSymptomNames(profile.id),
      rankedKeys: getSymptomLogOrder(profile.id),
      temperatureUnit: getUnitPrefs(login.id).temperatureUnit,
      timeZone: getTimezone(profile.id),
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
  const dueNow = collectDueDosesNow(profile.id, date, nowHhmm);
  // The items today's list already shows, for the fold below to subtract.
  const doseItemIds = dueNow.map((item) => item.itemId);
  const doses = dueNow.map((item) => ({
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
  const pastPending = doseLogDays(date)
    .slice(1)
    .map((day) => ({ date: day, pending: pendingDayDoses(profile.id, day) }));
  const pastDays = pastPending.map(({ date: day, pending }) => ({
    date: day,
    slots: groupDosesByBucket(pending),
  }));
  return {
    form: "dose",
    today: date,
    doses,
    prn: {
      meds: prnMeds,
      tz,
      timeFormat: formatPrefs.timeFormat,
      nowIso: now.toISOString(),
      pediatric: getPediatricFormContext(
        profile.id,
        getUnitPrefs(login.id).weightUnit
      ),
    },
    pastDays,
    others: {
      // WHAT EACH DAY ALREADY SHOWS is what the fold subtracts, and it is read from
      // the very lists above rather than re-derived: a fold that double-listed a due
      // item would be the one defect this row can introduce. The as-needed list is
      // drawn on EVERY day the sheet stands on, so its ids are subtracted from all of
      // them; the scheduled half differs per day, which is why this is keyed by date.
      byDate: quickEntryOthersByDate(
        profile.id,
        [
          { date, shown: doseItemIds },
          ...pastPending.map(({ date: day, pending }) => ({
            date: day,
            shown: pending.map((dose) => dose.itemId),
          })),
        ],
        prnMeds.map((med) => med.id),
        tz,
        formatPrefs.timeFormat
      ),
      nowHhmm,
    },
  };
}

// The fold's items for each offered day (#5808).
//
// NO NEW STATEMENT, AND NO NEW CACHE. The catalog half is `getIntakeItems` +
// `getIntakeDoses` — the same two snapshot-cached reads `collectDueDosesNow` has
// already run on this request, so asking for the whole catalog here costs nothing —
// and the only read of its own is the day's administrations, through the BATCHED
// `getAdministrationsForItemsOnDate` the medications Today panel already uses (one
// bounded query per day, exactly as `pendingDayDoses` above is already one read per
// day). A fold-specific SQL statement would have been a third opinion about what an
// item's usual amount is.
//
// ACTIVE ITEMS WITH A LIVE DOSE ROW. An item with no dose row has nothing to write
// against (`logHistoricalDose` takes a dose id), and an inactive one is not on offer;
// `getIntakeItems` orders `active DESC, name`, so the surviving order is the
// alphabetical one the catalog pages read down.
function quickEntryOthersByDate(
  profileId: number,
  days: readonly { date: string; shown: readonly number[] }[],
  alwaysShownItemIds: readonly number[],
  tz: string,
  timeFormat: TimeFormat
): Record<string, QuickEntryOtherItem[]> {
  // FIRST live dose per item — `getIntakeDoses` excludes retired rows and orders
  // (item_id, sort, id), so first-seen IS that row.
  const firstDose = new Map<
    number,
    ReturnType<typeof getIntakeDoses>[number]
  >();
  for (const dose of getIntakeDoses(profileId)) {
    if (!firstDose.has(dose.item_id)) firstDose.set(dose.item_id, dose);
  }
  const catalog = getIntakeItems(profileId).filter(
    (item) => item.active === 1 && firstDose.has(item.id)
  );
  const always = new Set(alwaysShownItemIds);
  const byDate: Record<string, QuickEntryOtherItem[]> = {};
  for (const { date, shown } of days) {
    const hidden = new Set([...always, ...shown]);
    const rows = catalog.filter((item) => !hidden.has(item.id));
    const logs = getAdministrationsForItemsOnDate(
      profileId,
      rows.map((item) => item.id),
      date
    );
    byDate[date] = rows.map((item) => {
      const dose = firstDose.get(item.id)!;
      // The amount IN FORCE ON THAT DAY (#1973), never the live row: a dose whose
      // amount changed last week must not relabel the day before it.
      const amount = doseScheduleAsOf(dose, date).amount ?? null;
      // Most-recent-intake first, which is `getAdministrationsForItemsOnDate`'s own
      // ordering — so this is the day's LATEST dose, the one a second tap follows.
      // ASKED, NOT PAIRED BY HAND (#2205): `bestKnownInstant` answers with the stated
      // administration instant when the row has one and the capture stamp otherwise,
      // and SAYS which — the fall this fact makes is the same one the as-needed row's
      // "last 4:02pm" makes, and it is named rather than spelled as a `??`.
      const latest = logs.get(item.id)?.[0];
      const takenInstant = latest
        ? bestKnownInstant("intake_item_logs", latest, tz)
        : null;
      return {
        itemId: item.id,
        doseId: dose.id,
        name: item.name,
        detail:
          item.kind === "medication"
            ? formatMedicationDoseProduct(amount, item.product)
            : amount,
        takenAt: takenInstant?.known
          ? clockOfInstant(tz, takenInstant.at, timeFormat)
          : null,
      };
    });
  }
  return byDate;
}

// One logged administration's profile-local clock ("8:15am"), through the login's own
// 12h/24h preference. The lower-case, space-less meridiem is the facts column's
// register, not a heading's.
function clockOfInstant(
  tz: string,
  iso: string,
  timeFormat: TimeFormat
): string {
  const [h, m] = zonedDateParts(tz, new Date(iso)).hhmm.split(":");
  return formatClock(timeFormat, Number(h), Number(m), "lower-nospace");
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
        amountAssumed: dose.amountAssumed,
      })),
  })).filter((slot) => slot.doses.length > 0);
}
