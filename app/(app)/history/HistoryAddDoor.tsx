"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import InlineError from "@/components/InlineError";
import { useToast } from "@/components/Toast";
import type { UsualRoutineDayOffer } from "@/lib/queries/usual-routine";
import UsualRoutineControl from "@/components/dashboard/UsualRoutineControl";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import {
  doseOptionsFor,
  type DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedInstantOnDate } from "@/lib/stated-time";
import PracticeSessionForm from "@/components/practices/PracticeSessionForm";
import SubstanceForm from "@/components/substances/SubstanceForm";
import SymptomForm from "@/components/illness/SymptomForm";
import StoolForm from "@/components/stool/StoolForm";
import MeasurementsQuickAdd from "@/app/(app)/trends/MeasurementsQuickAdd";
import { FOOD_GROUPS } from "@/lib/food-groups";
import type { FoodSlotBoundaries } from "@/lib/food-slot";
import FoodServingForm from "@/components/nutrition/FoodServingForm";
import type { MeasurementsQuickEntry } from "@/lib/quick-entry-measurements";
import MoodForm, { type MoodFormDay } from "@/components/mood/MoodForm";

// THE ADD DOOR RESOLVES IN PLACE (#4045 §1), which is what #3958 asked for and what
// only the dose kind shipped: "one door, kind-resolved — filtered to a kind it IS that
// kind's backfill". The other kinds rendered plain redirect links, so the page
// built for FINDING a gap in the record sent the reader somewhere else to fill it and
// lost the day they were looking at on the way. `body` was the loudest of them: it
// pointed at `/trends/metric/weight`, as if a body reading were only ever a weight.
//
// NO SIXTH WRITE CORE. Each form below posts the domain's own create action —
// `logFoodServing`, `logPractice`, `addSubstanceDailyTotalAction`, `addMeasurements` —
// exactly as HistoryRows' correction forms post that domain's own update action. Each
// one re-checks write access server-side, so the door is an affordance and never a gate.
//
// THE CONTROL KEEPS ONE IDENTITY while its form is open, and dismissal belongs to the
// form (#3911), so every record door keeps the identity that opened it instead of
// turning that control into Cancel.
//
// THE DATE OPENS ON THE DAY THE READER WAS LOOKING AT, not on today: the whole reason
// to add from here is a gap you just found. Bounded by today at every kind, which is
// the record's own never-the-future rule.
//
// AND THE WHEN IS `WhenControl`, WHICH #3958 NAMES — "WhenControl absolutes only,
// #2236 invariant 4". Phase 1's doors carried a bare date and posted the time EMPTY on
// purpose, because the alternative on offer was an eleventh hand-rolled
// <input type="time"> and the #2236 ratchet refuses those, correctly. The shared
// control is the answer that was missing, and #4060 converged the quick logger's
// vocabulary onto it, so there is no longer a second spelling to collide with.
//
// It buys the thing the empty field could not: a reader backfilling yesterday's 7am
// session can SAY 7am. What it does not do is invent one — invariant 3, an untouched
// time field stays empty and emits null, so a backfill that states nothing still
// states nothing, which is the behaviour phase 1 was protecting.
//
// BODY NO LONGER KEEPS A BARE DATE, because it no longer keeps a form (#4424 ruling 2).
// This door drew three of the domain's measures behind a `DateField` and posted
// `addBodyMetric` — a fourth body write action that stated no time at all — while the
// record above it fans every body measure onto the feed. It mounts the domain's ONE
// form instead, which carries the whole field set, the sitting's optional Time through
// the shared `WhenControl`, and `addMeasurements` with its never-the-future day bound.
// SUBSTANCE is date-only in the SCHEMA (`substance_daily_totals` is a day total with no
// event instant, #3327) and its own form now says so.

const KIND_LABEL = {
  food: "Log food",
  dose: "Log past dose",
  practice: "Log a practice",
  mood: "Log a check-in",
  substance: "Log a use",
  body: "Log a reading",
  symptom: "Log a symptom",
  stool: "Log a movement",
} as const;

export type HistoryAddKind = keyof typeof KIND_LABEL;

/** The per-kind vocabulary the server reads once for the page. */
export interface HistoryAddVocabulary {
  /** Practices this profile tracks. An empty list renders no practice door. */
  practices: string[];
  /**
   * The items a past dose may be logged against — only those with a LIVE dose, so an
   * item whose schedule is retired keeps its history and takes no new rows. Empty for
   * every other kind, and an empty list renders no dose door.
   */
  doseItems: DoseLedgerItem[];
  /** The profile-local clock a dose backfill prefills its time with. */
  doseDefaultTime: string;
  /** This profile's substance keys, with the label its record prints. */
  substances: { key: string; label: string }[];
  /**
   * The symptom vocabulary this profile picks from — the curated catalog plus its own
   * customs, in the order its history ranks them (#857). Empty for every other kind.
   */
  symptoms: { key: string; label: string }[];
  /**
   * What the body domain's one form needs to stand on the day being read — the SAME
   * reader the quick-log sheet's measurements overlay uses (#4424 ruling 2), so the
   * door and the sheet cannot offer different field sets for one form.
   */
  measurements: MeasurementsQuickEntry;
  /** The record day's full check-in seed and the canonical Calm relevance verdict. */
  moodDay: MoodFormDay;
  moodShowCalm: boolean;
  /**
   * The acting profile's meal-bucket boundaries, so the food form's meal follows the
   * hour a backfill states on this door exactly as it does in the nutrition bar
   * (#2227 decision 4). Two numbers; the same read the bar's mount already makes.
   */
  foodSlotBoundaries: FoodSlotBoundaries;
}

// ── THE DAY'S STANDING OFFERS, ABOVE THE DOOR ROW (#4310 ruling) ─────────────
//
// The composed one-tap is an OFFER over foods and stacks (#4477's vocabulary) and never
// a food: the tap writes servings AND doses. Under `Log food` the label under-named it,
// and a reader reconstructing a day met the bundle behind the food door and the per-dose
// backfill behind `Log a dose`. So the add door LEADS with the day's standing offers, in
// the same accent offer chip the quick-log sheet's food overlay leads with, and the door
// row keeps its per-kind grammar beneath.
//
// UNCHANGED IN THE MOVE: the day it stands on (#4118 — the record day, which is the day
// its own label names) and resolving in place (#4045 §1). What went is the `close()`,
// because there is no panel of its own to close from out here.
//
// ON A DAY WITH NO STANDING OFFER IT RENDERS NOTHING, which is what lets it sit above
// every kind rather than inside one — the offer's own gate is the food half, and the
// line is silent wherever that gate is.
export function HistoryUsualOffers({
  offers,
  date,
}: {
  offers: UsualRoutineDayOffer[];
  /** The day the reader is looking at, or today. */
  date: string;
}) {
  const router = useRouter();
  if (offers.length === 0) return null;
  return (
    // A PLAIN BLOCK, NOT A GRID (#4918 ruling 6). A grid track's default minimum is
    // its item's max-content width, so the offer button was sized to its own
    // single-line summary and `UsualRoutineControl`'s `truncate` span never got a
    // narrower box to truncate in — the card ran ~400px past the column every other
    // block on the page stops at. One or two offers stack the same way in a block,
    // and the shared control's own `min-w-0` seam (components/OfferRow.tsx) is what
    // stops any future host repeating it.
    <div data-testid="history-add-usual">
      {offers.map((offer) => (
        <UsualRoutineControl
          key={offer.window}
          window={offer.window}
          food={offer.food}
          proteinGrams={offer.proteinGrams}
          doses={offer.doses}
          subjectName={null}
          date={date}
          testIds={{
            button: `history-add-usual-${offer.window}`,
            names: `history-add-usual-${offer.window}-names`,
          }}
          onLogged={() => router.refresh()}
        />
      ))}
    </div>
  );
}

export default function HistoryAddDoor({
  kind,
  date,
  maxDate,
  vocabulary,
  window = null,
}: {
  kind: HistoryAddKind;
  /** The day the reader is looking at, or today. */
  date: string;
  maxDate: string;
  vocabulary: HistoryAddVocabulary;
  /**
   * The window the day chart was showing when a kind chip was tapped (#4950), as
   * `HH:MM` clocks on `date`. It arrives from the URL rather than from the chart, so
   * this door needs no client state of its own and the window survives a reload of the
   * link with the form open.
   *
   * Every form treats it as a DEFAULT a person can change, never as a write: a stated
   * window is a stated time, not a claim about what happened.
   */
  window?: { from: string; to?: string } | null;
}) {
  const router = useRouter();
  const formatPrefs = useFormatPrefs();
  const tz = useTimezone();
  const toast = useToast();
  // THE WINDOW AS THE `WhenControl` KINDS SPELL IT (#4950 item 3): one stated instant
  // on the day in hand, built once here rather than in each form, so food, body and a
  // movement cannot disagree about what `19:10` on this day means. Null when no window
  // was stated, and null when the clock does not exist on this day — a spring-forward
  // gap is refused rather than settled onto a different reading (`statedInstantOnDate`).
  const windowStatedAt =
    window == null
      ? null
      : (statedInstantOnDate(date, window.from, tz)?.toISOString() ?? null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (kind === "dose" && vocabulary.doseItems.length === 0) return null;
  if (kind === "practice" && vocabulary.practices.length === 0) return null;
  if (kind === "substance" && vocabulary.substances.length === 0) return null;
  if (kind === "symptom" && vocabulary.symptoms.length === 0) return null;

  function close(): void {
    setOpen(false);
    setError(null);
  }
  function form(): ReactNode {
    switch (kind) {
      case "food":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2): this door's own food
        // form — a group select, a meal select and a when-control with no
        // meal-follows-the-hour rule — is deleted and the domain's one form mounts
        // with the found day in hand.
        return (
          <FoodServingForm
            groups={FOOD_GROUPS}
            date={date}
            slotBoundaries={vocabulary.foodSlotBoundaries}
            maxDate={maxDate}
            defaultStatedAt={windowStatedAt}
            testId="history-add-food"
            onSaved={() => {
              toast("Added to the record.");
              close();
              router.refresh();
            }}
            onCancel={close}
          />
        );
      case "dose":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2). The dose kind already
        // opened a form in place, but through `DoseBackfillLauncher` — its own toggle,
        // its own item picker, and NO day. The launcher is deleted.
        return (
          <HistoricalDoseForm
            items={vocabulary.doseItems.map((item) => ({
              id: item.id,
              name: item.name,
              doses: doseOptionsFor(item, formatPrefs),
              asNeeded: item.asNeeded,
              courseBound: item.kind === "medication",
            }))}
            initialDate={date}
            maxDate={maxDate}
            /* The window's start beats the vocabulary's default (#4950): a person who
               framed 19:10 on the trace has said when, and `doseDefaultTime` is what
               to offer when nobody has. */
            defaultTime={window?.from ?? vocabulary.doseDefaultTime}
            repeatAfterAdd
            onSaved={() => router.refresh()}
            onDone={close}
          />
        );
      case "practice":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2): this door's own
        // practice form — a start with no end, so a window it could state here was
        // correctable only on the Wellness card — is deleted and the domain's one form
        // mounts with the found day in hand. The close and re-read stay the door's.
        return (
          <PracticeSessionForm
            practices={vocabulary.practices}
            // The door is bounded by today at every kind (see the header), so
            // `maxDate` IS this profile's today — there is no second day to pass.
            today={maxDate}
            date={date}
            maxDate={maxDate}
            defaultStartTime={window?.from ?? null}
            defaultEndTime={window?.to ?? null}
            onSaved={() => {
              close();
              router.refresh();
            }}
            onCancel={close}
          />
        );
      case "substance":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2): this door's own substance
        // form — with the bare "Amount" — is deleted and the domain's one form mounts
        // with the found day in hand. The close and re-read stay the door's.
        return (
          <SubstanceForm
            substances={vocabulary.substances}
            date={date}
            maxDate={maxDate}
            onSaved={() => {
              close();
              router.refresh();
            }}
            onCancel={close}
          />
        );
      case "mood":
        // NO WINDOW HERE, and none missing: a check-in has a day and no event instant,
        // so there is no time control for a stated window to open (#4950 item 3, "a
        // form with no time control ignores the window"). Same for `symptom` below,
        // whose store is UNIQUE(profile_id, date, symptom).
        return (
          <MoodForm
            days={[vocabulary.moodDay]}
            showCalm={vocabulary.moodShowCalm}
            dateReach="dated"
            repeatAfterSave
            onSaved={() => router.refresh()}
            onCancel={close}
          />
        );
      case "symptom":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2, amended by #4851 to
        // "symptom is an add-door kind everywhere"). This is now the record's ONLY
        // symptom entry surface: the day view's standalone bar card retired with #4851,
        // because carrying two entry surfaces for the one kind that had two is what put
        // "+ Log symptom" on its own line below the chart. The domain's form is here,
        // with the found day in hand.
        //
        // NO `dateField`: the store is UNIQUE(profile_id, date, symptom) and the form
        // says so — the day is the door's, not a field inside it.
        return (
          <SymptomForm
            symptoms={vocabulary.symptoms}
            date={date}
            onSaved={() => {
              close();
              router.refresh();
            }}
            onCancel={close}
          />
        );
      case "stool":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2), and the door stool never
        // had: the quick sheet's tap stamps today, so before this a movement remembered
        // an hour later on the way home could be logged and a movement remembered the
        // NEXT day could not be logged at all. The domain's form is that way, with the
        // found day in hand.
        return (
          <StoolForm
            date={date}
            maxDate={maxDate}
            defaultStatedAt={windowStatedAt}
            onSaved={() => {
              close();
              router.refresh();
            }}
            onCancel={close}
          />
        );
      case "body":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2). The domain's one form,
        // with the found day in hand — every measure the record's body rows print, not
        // the three this door used to draw.
        //
        // IT STAYS OPEN AFTER A SAVE, which is the one behaviour this mount adds and
        // the #4211 requirement absorbed into #4424: the form resets its own fields and
        // keeps its date, so five readings backfilled onto one past day are five quick
        // saves rather than five re-openings. `router.refresh()` is what puts each of
        // them into the record the reader is standing in; `close()` is deliberately NOT
        // called, and the form's own toast is the confirmation.
        return (
          <MeasurementsQuickAdd
            {...vocabulary.measurements}
            presentation="modal"
            // The record's `body` rows ARE `body_metrics` (`bodyMetricMeasures` fans
            // weight, body fat and resting HR onto the feed), so the door opens on the
            // group holding them rather than on the form's own default.
            defaultGroup="body"
            /* The window beats the day's existing manual instant (#4950): a person who
               framed 19:10 on the trace has said when, and the seed is what to offer
               when nobody has. */
            defaultStatedAt={
              windowStatedAt ?? vocabulary.measurements.defaultStatedAt
            }
            onSaved={() => router.refresh()}
          />
        );
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm shrink-0"
        aria-expanded={open}
        data-testid={`history-add-open-${kind}`}
        onClick={() => setOpen((value) => !value)}
      >
        {KIND_LABEL[kind]}
      </button>
      {open ? (
        <div className="mt-2" data-testid={`history-add-panel-${kind}`}>
          {form()}
          <InlineError data-testid={`history-add-error-${kind}`}>
            {error}
          </InlineError>
        </div>
      ) : null}
    </>
  );
}
