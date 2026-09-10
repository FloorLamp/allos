"use client";
/* eslint-disable no-restricted-properties -- USER-initiated repaint (#1878): follows the user's own submit in the record's Add door (#4045) — the door writes a row into the very feed they are reading, and without the repaint it closes over a record that still shows the gap they opened it to fill */

import { type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ModalShell from "@/components/ModalShell";
import { useToast } from "@/components/Toast";
import type { UsualRoutineDayOffer } from "@/lib/queries/usual-routine";
import { UsualRoutineOfferCard } from "@/components/dashboard/UsualRoutineControl";
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
import { logHeading, type LogDomain } from "@/lib/log-manifest";

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

// THE DOOR NO LONGER NAMES ITS OWN KINDS (#5300 rule 6, #5617 step 2). It carried a
// second vocabulary for the eight domains the quick sheet had already named — four
// RENAMINGS ("Log a check-in" for mood, "Log a use" for substance, "Log a reading"
// for body, "Log a movement" for stool) and three articles ("Log a practice", "Log a
// symptom", "Log past dose") — so one domain answered to two phrases depending on
// which surface a person opened it from. The noun is declared once on the domain's
// manifest entry and every heading is built from it.
export type HistoryAddKind = LogDomain;

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
// backfill behind `Log dose`. So the add door LEADS with the day's standing offers, in
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
    // single-line summary and `UsualRoutineOfferCard`'s `truncate` span never got a
    // narrower box to truncate in — the card ran ~400px past the column every other
    // block on the page stops at. One or two offers stack the same way in a block,
    // and the shared control's own `min-w-0` seam (components/OfferRow.tsx) is what
    // stops any future host repeating it.
    <div data-testid="history-add-usual">
      {offers.map((offer) => (
        <UsualRoutineOfferCard
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
  label,
  open,
  onOpen,
  onClose,
  date,
  maxDate,
  vocabulary,
  window = null,
  defaultPractice = null,
}: {
  kind: HistoryAddKind;
  /**
   * WHAT THE CHIP READS (#5618 ruling 1). The trigger is the record's own kind chip
   * now, so it carries the chip row's short plural word ("Substances") rather than a
   * second phrase of the door's own. The HEADING over the form is still the manifest's
   * `Log <noun>` (below) — one vocabulary names the domain, one names the filter, and
   * neither is invented here.
   */
  label: string;
  /**
   * Whether this kind's form is the one showing. THE ROW OWNS IT, not the door: a
   * record has one add layer and one form open in it, and a door that kept its own
   * closed state was the thing nothing could open (#5618, the owner's report).
   */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** The day the reader is looking at, or today. */
  date: string;
  maxDate: string;
  vocabulary: HistoryAddVocabulary;
  /**
   * The window the day chart is showing (#4950), as `HH:MM` clocks on `date`. It comes
   * from the add row, which reads the chart's own live view — a chip no longer
   * navigates, so there is no URL round trip left to mint it (#5618 ruling 1).
   *
   * Every form treats it as a DEFAULT a person can change, never as a write: a stated
   * window is a stated time, not a claim about what happened.
   */
  window?: { from: string; to?: string } | null;
  /**
   * The practice this profile usually does at the window's moment (#4950 item 4),
   * decided by the add row from the rhythms the server read, and always one of
   * `practices`. A prefill a tap confirms, never a claim about what happened — and
   * null whenever the rhythm is unknown, which leaves the picker as it is without a
   * window.
   */
  defaultPractice?: string | null;
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

  if (kind === "dose" && vocabulary.doseItems.length === 0) return null;
  if (kind === "practice" && vocabulary.practices.length === 0) return null;
  if (kind === "substance" && vocabulary.substances.length === 0) return null;
  if (kind === "symptom" && vocabulary.symptoms.length === 0) return null;

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
              onClose();
              router.refresh();
            }}
            onCancel={onClose}
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
            onDone={onClose}
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
            defaultPractice={defaultPractice}
            onSaved={() => {
              onClose();
              router.refresh();
            }}
            onCancel={onClose}
          />
        );
      case "substance":
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2): this door's own substance
        // form — with the bare "Amount" — is deleted and the domain's one form mounts
        // with the found day in hand. The close and re-read stay the door's.
        //
        // A use is an EVENT with its own `occurred_at` (#5026 phase 2), so the form
        // reads the window like every other timed kind here (#5615).
        return (
          <SubstanceForm
            substances={vocabulary.substances}
            date={date}
            maxDate={maxDate}
            defaultStatedAt={windowStatedAt}
            onSaved={() => {
              onClose();
              router.refresh();
            }}
            onCancel={onClose}
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
            onCancel={onClose}
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
              onClose();
              router.refresh();
            }}
            onCancel={onClose}
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
              onClose();
              router.refresh();
            }}
            onCancel={onClose}
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
        // them into the record the reader is standing in; `onClose()` is deliberately NOT
        // called, and the form's own toast is the confirmation.
        return (
          <MeasurementsQuickAdd
            {...vocabulary.measurements}
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
        aria-haspopup="dialog"
        data-testid={`history-add-open-${kind}`}
        onClick={() => (open ? onClose() : onOpen())}
      >
        {label}
      </button>
      {open ? (
        // ONE HOST (#5300 rule 5, adopted by #5617 step 1). This was an inline panel
        // under the button — `<div className="mt-2">` holding the domain's form — so
        // the same eight forms had three hosts between them: this panel, the record
        // row's in-row editor, and the converged sheet/dialog the quick logger and
        // the nutrition day correction already used. A sheet below `md` and a centred
        // card above is what every other transactional capture in the app opens as,
        // and it is what the owner ruled the record's forms open in ("we do the
        // sheet").
        //
        // WHAT THE MOVE BUYS beyond uniformity: the form no longer competes with the
        // record it is writing into for the reader's screen — the add layer sits
        // under a day chart and above the rows, so an opened panel pushed the rows it
        // was about off the fold. It gains the host's body-scroll lock, its
        // dirty-discard guard on a flick or a scrim tap, and its focus trap; none of
        // those were reachable from an inline div.
        //
        // THE TRIGGER KEEPS ITS IDENTITY (#3911) and its `aria-expanded`: the control
        // still says what it is FOR rather than turning into Cancel, and dismissal
        // still belongs to the surface it opened. `aria-haspopup` is what changed —
        // the content it discloses is a dialog now, and a reader is owed that.
        //
        // AND THE TRIGGER IS THE KIND CHIP ITSELF (#5618 ruling 1). It was a second
        // control below a chip that had already navigated: "I click Substances — every
        // row on the left gets filtered away. Then I still have to click Log a use, a
        // button that doesn't have an expanded state." One chip, one tap, the rows
        // stay, and the expanded state the reader was owed is the chip's.
        //
        // THE SIZE MIRRORS THE QUICK SHEET'S (#4977 item 1): the measurements grid is
        // a multi-column tool and declares `lg` there, every other body a column of
        // rows at `sm`. It is stated here rather than read from the manifest because
        // the size vocabulary is `components/overlay`'s and `lib/log-manifest.ts` is
        // dependency-free by contract — see #5617 for the unification that would
        // need.
        <ModalShell
          title={logHeading(kind)}
          onClose={onClose}
          size={kind === "body" ? "lg" : "sm"}
          testId={`history-add-sheet-${kind}`}
        >
          {/* THE PANEL MARKER STAYS ON THE FORM'S OWN WRAPPER, not on the host: it is
              what every spec on this door identifies the form by, and the host's
              chrome is the host's to assert. */}
          <div data-testid={`history-add-panel-${kind}`}>{form()}</div>
        </ModalShell>
      ) : null}
    </>
  );
}
