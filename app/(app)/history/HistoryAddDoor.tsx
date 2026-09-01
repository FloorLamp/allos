"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import WhenControl from "@/components/WhenControl";
import { statedHhmm, type WhenValue } from "@/lib/stated-time";
import { useTimezone } from "@/components/TimezoneProvider";
import InlineError from "@/components/InlineError";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import { useToast } from "@/components/Toast";
import { logFoodServing } from "@/app/(app)/nutrition/actions";
import { logUsualRoutine, usualRoutineOffersOn } from "@/app/(app)/actions";
import {
  usualRoutineAnswerText,
  usualRoutinePhrase,
} from "@/lib/usual-routine";
import type { UsualRoutineDayOffer } from "@/lib/queries/usual-routine";
import { logPractice } from "@/app/(app)/wellness/actions";
import SubstanceForm from "@/components/substances/SubstanceForm";
import SymptomForm from "@/components/illness/SymptomForm";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { validateBodyMetricInput } from "@/lib/body-metric-input";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { FOOD_SLOTS } from "@/lib/food-slot";
import type { WeightUnit } from "@/lib/settings";

// THE ADD DOOR RESOLVES IN PLACE (#4045 §1), which is what #3958 asked for and what
// only the dose kind shipped: "one door, kind-resolved — filtered to a kind it IS that
// kind's backfill". The other four kinds rendered plain redirect links, so the page
// built for FINDING a gap in the record sent the reader somewhere else to fill it and
// lost the day they were looking at on the way. `body` was the loudest of them: it
// pointed at `/trends/metric/weight`, as if a body reading were only ever a weight.
//
// NO SIXTH WRITE CORE. Each form below posts the domain's own create action —
// `logFoodServing`, `logPractice`, `addSubstanceDailyTotalAction`, `addBodyMetric` —
// exactly as HistoryRows' correction forms post that domain's own update action. Each
// one re-checks write access server-side, so the door is an affordance and never a gate.
//
// THE CONTROL KEEPS ONE IDENTITY while its form is open, and dismissal belongs to the
// form. `DoseBackfillLauncher` follows the same rule (#3911), so all five record doors
// keep the identity that opened them instead of turning that control into Cancel.
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
// BODY KEEPS A BARE DATE, and that is not an oversight: `body_metrics.occurred_at`
// exists (migration 165, #2235) and the write core takes it, but `addBodyMetric`
// deliberately states no time, and its find-then-write CLEARS the column on an empty
// submission while leaving it alone for a time-blind one. Choosing between those is a
// decision about the body domain's write contract, not about this door. SUBSTANCE is
// date-only in the SCHEMA (`substance_daily_totals` is a day total with no event
// instant, #3327) and its own form now says so.

const KIND_LABEL = {
  food: "Log food",
  practice: "Log a practice",
  substance: "Log a use",
  body: "Log a reading",
  symptom: "Log a symptom",
} as const;

export type HistoryAddKind = keyof typeof KIND_LABEL;

/** The per-kind vocabulary the server reads once for the page. */
export interface HistoryAddVocabulary {
  /** Practices this profile tracks. An empty list renders no practice door. */
  practices: string[];
  /** This profile's substance keys, with the label its record prints. */
  substances: { key: string; label: string }[];
  /**
   * The symptom vocabulary this profile picks from — the curated catalog plus its own
   * customs, in the order its history ranks them (#857). Empty for every other kind.
   */
  symptoms: { key: string; label: string }[];
  /** The login's weight unit — what the value the reader types is in. */
  weightUnit: WeightUnit;
  /**
   * The composed "your usual <window>" offers standing on the day being read (#4118),
   * one per window, seeded server-side. Empty for every kind but `food`, for a day
   * outside the bundle's reach, and for a profile with no habit to offer.
   */
  usual: UsualRoutineDayOffer[];
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
  const tz = useTimezone();
  // THE PAIR, held as one value (#2236 invariant 1). `date` opens on the day the
  // reader was looking at and `statedAt` opens EMPTY — never defaulted to now.
  const [when, setWhen] = useState<WhenValue>({ date, statedAt: null });
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
  // The web's answer to "reconstruct an empty day". Everything below the label is
  // already built: the offer read is date-parameterized, the write core takes a day,
  // and the bound is the core's. What the door adds is the affordance the ruling names
  // — the composed bundle, seeded to the day being read.
  //
  // THE OFFER FOLLOWS THE DATE FIELD, and that is not a nicety. The label names every
  // serving and every dose the tap will write, so an offer resolved once at render and
  // left there would keep promising Tuesday's breakfast while the field said Thursday —
  // and `logUsualRoutineCore`, which re-derives against the day it is HANDED, would
  // write something else or refuse. One re-read per date change keeps the promise and
  // the write describing the same day.
  //
  // THE RE-READ IS SEQUENCED, not merely awaited. Two quick date changes are two
  // in-flight reads, and the network may answer them in either order; a late reply for
  // an abandoned day would repaint the label with an offer for a day nobody is looking
  // at any more — the label lying again, by a different route. `latestRead` is the
  // ticket, and a stale answer is dropped rather than rendered.
  const seededDate = date;
  const [usual, setUsual] = useState<UsualRoutineDayOffer[]>(vocabulary.usual);
  const latestRead = useRef(0);
  useEffect(() => {
    if (when.date === seededDate) {
      // The server already answered for this day; re-asking would repaint the same
      // list and race the seed on mount.
      latestRead.current += 1;
      setUsual(vocabulary.usual);
      return;
    }
    const ticket = (latestRead.current += 1);
    void usualRoutineOffersOn(when.date)
      .then((offers) => {
        if (latestRead.current === ticket) setUsual(offers);
      })
      .catch(() => {
        // A failed read must not leave a promise standing about a day it could not ask
        // about. No offer is the honest render, and the manual form below is untouched.
        if (latestRead.current === ticket) setUsual([]);
      });
  }, [when.date, seededDate, vocabulary.usual]);

  if (kind === "practice" && vocabulary.practices.length === 0) return null;
  if (kind === "substance" && vocabulary.substances.length === 0) return null;
  if (kind === "symptom" && vocabulary.symptoms.length === 0) return null;

  function close(): void {
    setOpen(false);
    setError(null);
  }

  // One submit path for four forms: post, report a refusal inline, and on success
  // re-read the feed so the row the reader just wrote is IN the record they are
  // looking at. Without the refresh the door would write silently and read as dead —
  // the same complaint as the redirect it replaces.
  //
  // `announce` EXISTS BECAUSE ONE CALLER CAN PARTLY SUCCEED (#4118). The four forms
  // each write one row, so "Added to the record." is the whole truth for them. The
  // composed bundle writes several, and its typed outcome reports each dose
  // separately — so it supplies its own sentence rather than being flattened into a
  // confirm it did not earn (#232). Optional, so nothing else has to know.
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

  async function post(
    event: FormEvent<HTMLFormElement>,
    run: (fd: FormData) => Promise<string | null>
  ): Promise<void> {
    event.preventDefault();
    return submit(stampLoggedVia(new FormData(event.currentTarget)), run);
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
              aria-label={`Your usual ${offer.window} on ${when.date}: ${phrase}`}
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
                    fd.set("date", when.date);
                    // Both lists are UPPER BOUNDS the core intersects with what still
                    // stands on that day — never an instruction to write outside it.
                    fd.set("groups", offer.food.map((f) => f.slug).join(","));
                    fd.set("dose_ids", offer.doses.map((d) => d.id).join(","));
                    const outcome = await logUsualRoutine(fd);
                    if (!outcome.ok) return outcome.error;
                    // `usualRoutineAnswerText` — the SAME sentence the dashboard
                    // control and the Telegram ack render, so three surfaces cannot
                    // round one outcome three ways. The logged/refused split is spelled
                    // as the dashboard spells it rather than through
                    // `usualRoutineDoseLogged`, which lives beside the write core and
                    // would pull the database into this client bundle.
                    const wrote = new Set(
                      outcome.groups.map((g) => g.groupKey)
                    );
                    const landed = (o: string) =>
                      o === "logged" || o === "logged-off-day";
                    answer = usualRoutineAnswerText(
                      offer.food
                        .filter((f) => wrote.has(f.slug))
                        .map((f) => f.name),
                      outcome.doses
                        .filter((d) => landed(d.outcome))
                        .map((d) => d.name),
                      outcome.doses
                        .filter((d) => !landed(d.outcome))
                        .map((d) => d.name)
                    );
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

  // BODY's field, and still `DateField` rather than a `WhenControl` with its time
  // hidden: a control rendered without half of itself is a variant.
  const dateField = (
    <label className="text-xs text-slate-500 dark:text-slate-400">
      Date
      <DateField
        name="date"
        defaultValue={date}
        max={maxDate}
        required
        inputClassName="mt-1 w-full"
      />
    </label>
  );

  // The TIMED kinds' field, and the day and the minute come out of it together.
  // `mode="state"` because a backfill is an assertion rather than an amendment, and
  // `timeRequired` is false because stating a time is optional here — the record's own
  // clock grammar already has an honest rendering for a row that names none.
  const whenField = (
    <div className="sm:col-span-2">
      <WhenControl
        mode="state"
        grain="minute"
        value={when}
        onChange={setWhen}
        maxDate={maxDate}
        dateLabel="Date"
        timeLabel="Time"
        testId={`history-add-when-${kind}`}
      />
      {/* THE WIRE SHAPE IS THE DOMAIN'S, and both of these actions read an ABSOLUTE
          profile-local wall clock rather than a client instant — the server resolves
          it against its own clock and the profile's timezone (#2053), so no browser
          has to be trusted with the answer. `statedHhmm` is the one conversion, and
          it returns "" for an unstated instant, which is exactly the empty string
          both actions read as "no time was stated". */}
      <input type="hidden" name="date" value={when.date} />
    </div>
  );

  const buttons = (
    <div className="flex items-end gap-2">
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add"}
      </button>
      <button className="btn-ghost" type="button" onClick={close}>
        Cancel
      </button>
    </div>
  );

  function form(): ReactNode {
    switch (kind) {
      case "food":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                // The eating-time statement (#2053), as the wall clock the action
                // reads. Empty when nothing was stated, which `logFoodServing`
                // already treats as "no eating time" rather than as a refusal.
                fd.set("occurred_at", statedHhmm(when.statedAt, tz));
                const outcome = await logFoodServing(fd);
                return outcome.ok ? null : outcome.error;
              })
            }
          >
            {whenField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Food group
              <select name="group_key" className="input mt-1 w-full">
                {FOOD_GROUPS.map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Meal
              <select name="meal_slot" className="input mt-1 w-full">
                {FOOD_SLOTS.map((slot) => (
                  <option key={slot}>{slot}</option>
                ))}
              </select>
            </label>
            {buttons}
          </form>
        );
      case "practice":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                const outcome = await logPractice(fd);
                return outcome.kind === "logged"
                  ? null
                  : "Couldn't log that session.";
              })
            }
          >
            {whenField}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Practice
              <select name="practice" className="input mt-1 w-full">
                {vocabulary.practices.map((practice) => (
                  <option key={practice}>{practice}</option>
                ))}
              </select>
            </label>
            {/* THE FIELD IS ALWAYS POSTED, AND ITS VALUE IS NOW THE READER'S.
                `logPractice` reads PRESENCE, not value (#2204): an absent
                `start_time` means "you have the clock" and would stamp the filing
                instant onto a day that is not today, so this stays present
                unconditionally. Its value is the wall clock WhenControl collected —
                and an unstated time still resolves to "", which is the same honest
                "this session has no minute" the door has always been able to say.
                The field is `start_time` since #3142 renamed the column; posting the
                old name would have left the presence gate unsatisfied and stamped
                the tap instant over what the person actually said. NO `end_time`:
                this door states a start, and a session's window is the expanded
                form's to state. */}
            <input
              type="hidden"
              name="start_time"
              value={statedHhmm(when.statedAt, tz)}
            />
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min={1}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <input type="text" name="notes" className="input mt-1 w-full" />
            </label>
            {buttons}
          </form>
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
      case "body":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                // THE ACTION SILENTLY SKIPS an out-of-range number, so a reader who
                // typed one would watch the door close over nothing. The same pure
                // guard the two weight quick-adds run answers first.
                const refusal = validateBodyMetricInput({
                  weight: fd.get("weight") as string | null,
                  bodyFatPct: fd.get("body_fat_pct") as string | null,
                  restingHr: fd.get("resting_hr") as string | null,
                });
                if (refusal) return refusal;
                await addBodyMetric(fd);
                return null;
              })
            }
          >
            {dateField}
            {/* EVERY BODY MEASURE THE RECORD SHOWS, not weight alone — `body_metrics`
                holds three quantities per day and `bodyMetricMeasures` fans all three
                onto the feed, so a door that took only a weight could not backfill two
                thirds of the rows it sits above. `addBodyMetric` writes whichever
                fields carry a value. */}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              {`Weight (${vocabulary.weightUnit})`}
              <input
                type="number"
                step="any"
                name="weight"
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Body fat (%)
              <input
                type="number"
                step="any"
                name="body_fat_pct"
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Resting HR (bpm)
              <input
                type="number"
                name="resting_hr"
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
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
