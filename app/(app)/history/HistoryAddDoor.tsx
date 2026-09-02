"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { logUsualRoutine } from "@/app/(app)/actions";
import {
  usualRoutinePhrase,
  usualRoutineWriteAnswer,
} from "@/lib/usual-routine";
import type { UsualRoutineDayOffer } from "@/lib/queries/usual-routine";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import {
  doseOptionsFor,
  type DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
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
   * The composed "your usual <window>" offers standing on the day being read (#4118),
   * one per window, seeded server-side. Empty for every kind but `food`, for a day
   * outside the bundle's reach, and for a profile with no habit to offer.
   */
  usual: UsualRoutineDayOffer[];
  /**
   * The acting profile's meal-bucket boundaries, so the food form's meal follows the
   * hour a backfill states on this door exactly as it does in the nutrition bar
   * (#2227 decision 4). Two numbers; the same read the bar's mount already makes.
   */
  foodSlotBoundaries: FoodSlotBoundaries;
}

export default function HistoryAddDoor({
  kind,
  date,
  maxDate,
  vocabulary,
}: {
  kind: HistoryAddKind;
  /** The day the reader is looking at, or today. */
  date: string;
  maxDate: string;
  vocabulary: HistoryAddVocabulary;
}) {
  const router = useRouter();
  const formatPrefs = useFormatPrefs();
  const toast = useToast();
  // WHICH SURFACE THIS WRITE CAME FROM (#3087). The record is a page and `page` is what
  // this resolves to, but it is declared rather than left to the action's fallback:
  // three of these four actions read the surface off the post, and an undeclared
  // mounting answers `page` whether or not it is one.
  const stampLoggedVia = useLoggedViaStamp();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── THE ONE-TAP USUAL, ON A PAST DAY (#4118) ───────────────────────────────
  //
  // The web's answer to "reconstruct an empty day": the composed bundle, seeded to the
  // day being read. Everything below the label was already built — the offer read is
  // date-parameterized, the write core takes a day, and the bound is the core's.
  //
  // IT STANDS ON THE DOOR'S OWN DAY, and no longer chases a field. The door used to own
  // a shared date input above every kind's form, so the offer had to re-read whenever
  // that input moved or its label would keep promising Tuesday's breakfast while the
  // field said Thursday. Ruling 2 deleted that input — each domain's one form carries
  // its own date now — so the only day this control can be about is the record day it
  // is seeded for, which is the day its own label names. The sequenced re-read moved to
  // the nutrition bar, where a day PICKER still sits above the same offer.
  const usual = vocabulary.usual;

  if (kind === "dose" && vocabulary.doseItems.length === 0) return null;
  if (kind === "practice" && vocabulary.practices.length === 0) return null;
  if (kind === "substance" && vocabulary.substances.length === 0) return null;
  if (kind === "symptom" && vocabulary.symptoms.length === 0) return null;

  function close(): void {
    setOpen(false);
    setError(null);
  }

  // The composed bundle's submit path: post, report a refusal inline, and on success
  // re-read the feed so the rows the reader just wrote are IN the record they are
  // looking at. Every FORM here is now the domain's own (#4424 ruling 2) and owns its
  // write; what is left is the one control that is not a form.
  //
  // `announce` EXISTS BECAUSE THIS CALLER CAN PARTLY SUCCEED (#4118): the bundle writes
  // several rows and its typed outcome reports each dose separately, so it supplies its
  // own sentence rather than being flattened into a confirm it did not earn (#232).
  async function submit(
    fd: FormData,
    run: (fd: FormData) => Promise<string | null>,
    announce?: () => string
  ): Promise<void> {
    setError(null);
    setPending(true);
    let failure: string | null;
    try {
      failure = await run(fd);
    } catch {
      failure = "Couldn't save that entry.";
    }
    setPending(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast(announce?.() ?? "Added to the record.");
    close();
    router.refresh();
  }

  // One composed tap for one window. Posts the SAME action the dashboard control and
  // the Telegram button post, with the door's day — so the audit row, the provenance
  // stamp and the reach bound are the write core's, not this control's.
  function usualControls(): ReactNode {
    if (usual.length === 0) return null;
    return (
      <div className="mb-3 grid gap-2" data-testid="history-add-usual">
        {usual.map((offer) => {
          const phrase = usualRoutinePhrase(
            offer.food.map((f) => f.name),
            offer.doses
          );
          return (
            <button
              key={offer.window}
              type="button"
              disabled={pending}
              data-testid={`history-add-usual-${offer.window}`}
              data-groups={offer.food.map((f) => f.slug).join(",")}
              data-doses={offer.doses.map((d) => d.id).join(",")}
              aria-label={`Your usual ${offer.window} on ${date}: ${phrase}`}
              className="rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-left transition hover:bg-brand-50 disabled:opacity-50 dark:border-brand-900 dark:bg-brand-950/40 dark:hover:bg-brand-950/60"
              onClick={() => {
                // THE ANSWER NAMES WHAT WAS WRITTEN, NEVER WHAT WAS OFFERED. The core
                // reports every dose separately and refuses to assume any of them away
                // (lib/usual-routine-write.ts), and `ok: true` only means the bundle
                // wrote SOMETHING — so a flat "Added to the record." here would tell a
                // person their creatine was logged when the day was outside the dose
                // half's own ±2 window and nothing was. That is the unconditional
                // confirm #232 forbids, on the one surface that can reach those days:
                // the dashboard has no date field and the Telegram tap is gated to ±2.
                let answer: string | null = null;
                void submit(
                  stampLoggedVia(new FormData()),
                  async (fd) => {
                    fd.set("meal_slot", offer.window);
                    fd.set("date", date);
                    if (offer.proteinGrams != null)
                      fd.set("protein_grams", String(offer.proteinGrams));
                    // Both lists are UPPER BOUNDS the core intersects with what still
                    // stands on that day — never an instruction to write outside it.
                    fd.set("groups", offer.food.map((f) => f.slug).join(","));
                    fd.set("dose_ids", offer.doses.map((d) => d.id).join(","));
                    const outcome = await logUsualRoutine(fd);
                    if (!outcome.ok) return outcome.error;
                    // The SAME sentence the dashboard control, the nutrition bar and
                    // the Telegram ack render, through the one helper that owns the
                    // rounding (#4438 item 5).
                    answer = usualRoutineWriteAnswer(offer.food, outcome);
                    return null;
                  },
                  () => answer ?? "Added to the record."
                );
              }}
            >
              <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                {`Your usual ${offer.window} (${offer.food.length + offer.doses.length})`}
              </span>
              <span className="block text-xs text-slate-600 dark:text-slate-300">
                {phrase}
              </span>
            </button>
          );
        })}
      </div>
    );
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
            defaultTime={vocabulary.doseDefaultTime}
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
        // A DATE-CONTEXT WRAPPER, NOT A FORM (#4424 ruling 2). The day view's own
        // symptom card mounts the tap BAR, which is why this kind had no door at all —
        // but a reader filtered to `?kind=symptom` is standing on no day, so the record
        // could show symptom rows and correct them while offering no way to add one.
        // The domain's form is that way, with the found day in hand.
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
          {/* ABOVE the form, never inside it: the bundle is an alternative to filling
              the form out, and nesting a button in a <form> makes it a submit control
              of that form. The manual per-item path stays exactly where it was — the
              one-tap is the fast path and never the only one. */}
          {kind === "food" ? usualControls() : null}
          {form()}
          <InlineError data-testid={`history-add-error-${kind}`}>
            {error}
          </InlineError>
        </div>
      ) : null}
    </>
  );
}
