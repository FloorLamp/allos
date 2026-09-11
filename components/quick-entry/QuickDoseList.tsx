"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import DatedDoseControl from "@/components/medications/DatedDoseControl";
import QuickLogPrnContent from "@/components/medications/QuickLogPrnContent";
import Disclosure from "@/components/Disclosure";
import { LabeledVerbChip } from "@/components/OfferRow";
import { useTimeStatement } from "@/components/TimeStatement";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import {
  QuickEntryRow,
  QuickEntryRowList,
} from "@/components/quick-entry/QuickEntryRowList";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";
import { logHistoricalDose } from "@/app/(app)/nutrition/intake-actions";
import type {
  QuickEntryDose,
  QuickEntryOtherItem,
  QuickEntryOthers,
  QuickEntryPastDay,
  QuickEntryPastDose,
  QuickEntryPrn,
} from "@/app/(app)/quick-entry-actions";
import type { IntakeItemKind } from "@/lib/types";

// The quick-entry overlay's DOSE form (issue #1468), with the recent-past day
// switcher (#3936).
//
// It is a thin LIST over existing write paths, not a new one. Today's rows come from
// the same `collectDueDosesNow` computation the context chip reads. Nothing here logs
// a dose itself and nothing here draws a dose control: every row mounts
// `DoseStatusControl`, the domain's one row control (#4424 ruling 3).
//
// THE STRADDLE IS GONE. This file used to post `markTaken` for today and
// `resolveDayDoses` for a day behind it, with a "Mark taken" button for the one and an
// icon pair for the other — two write paths and two spellings of the row inside one
// list, which is what the manifest cell named. Both are one mount now, and today's row
// gains the skip and the way back that only the past day had.
//
// **It never unconditionally confirms.** A row leaves the list only when the write
// says it wrote; a refusal — a dose retired by a schedule edit, an item since paused —
// stays put with the honest message beside it, because it is still due. Saying "Dose
// logged" there would be a false confirmation of a possibly-critical medication (the
// #280 defect).
//
// ── THE DAY SWITCHER (#3936) ─────────────────────────────────────────────────
//
// Every fast path in the app was today/now-only, so a forgotten day cost N item
// traversals and N date/time forms — which is why a forgotten day stayed unlogged and
// the adherence record lied. The switcher offers exactly `doseLogDays(today)`: today,
// yesterday, the day before. Those three days are resolved SERVER-side from
// DOSE_LOG_DATE_WINDOW_DAYS, the same constant `markDoseTaken` / `markDoseSkipped`
// gate on, so the sheet cannot offer a day the write would refuse. A fourth day is a
// different decision and is not this control's to make.
//
// The day it is standing on is the ONLY thing that differs between these rows (#5753
// leg 1): one row composition, one control, one chip — see `PastDayDoses`, which draws
// the composition below rather than a second one of its own.
//
// The identity of one dose OCCURRENCE: the profile-local day it belongs to plus the
// schedule row that asks for it. Minted in exactly one place so no reader can key on
// half of it.
function occurrenceKey(date: string, doseId: number): string {
  return `${date}:${doseId}`;
}

export default function QuickDoseList({
  today,
  profileToday = today,
  doses,
  prn,
  pastDays,
  others,
  onDone,
  subjectProfileId,
  selectedDay,
  canAdd = false,
  onAdd,
  onPrnLogged,
  addFocusRef,
  focusReturnActivation,
  onReturnFocus,
}: {
  // The day whose current-day bucket produced `doses`. Usually the live profile day;
  // it can be the prior day while an in-reach cached response remains visible.
  today: string;
  // The live profile day. `today` remains the gathered payload's anchor: a cached
  // former-today response still carries its rows in `doses`, while this value says
  // that those rows now need an explicit historical write date.
  profileToday?: string;
  doses: QuickEntryDose[];
  prn?: QuickEntryPrn;
  pastDays: QuickEntryPastDay[];
  // The "Everything else" fold's offer per day (#5808) — the catalog slice this body
  // is not otherwise showing. Absent (or empty for the standing day) renders no fold.
  others?: QuickEntryOthers;
  // Called once the sheet has nothing left to confirm on ANY offered day — the
  // overlay closes itself rather than leaving an empty sheet on screen. Today
  // emptying on its own is NOT that moment any more: closing then would take the
  // switcher, and the missed day behind it, away with it.
  onDone: () => void;
  // The sheet's chosen subject (#4932), when it is not the acting profile —
  // `today`/`doses`/`pastDays` are already gathered for this subject; this is what
  // makes the WRITES cross the same boundary (#4429) rather than landing on the
  // acting profile the gather no longer reflects. `DoseStatusControl` and
  // `resolveDayDoses` both re-gate it server-side.
  subjectProfileId?: number;
  selectedDay: string;
  canAdd?: boolean;
  onAdd?: (kind: IntakeItemKind, trigger: HTMLButtonElement) => void;
  onPrnLogged?: () => void;
  addFocusRef?: { current: HTMLButtonElement | null };
  focusReturnActivation?: number;
  onReturnFocus?: (activation: number) => void;
}) {
  // Doses resolved during THIS overlay session, dropped from their day's list. Local
  // rather than re-fetched: the sheet is a transactional surface, and re-running the
  // gather mid-list would reorder rows under the user's finger.
  //
  // KEYED BY (DAY, DOSE), AND THAT IS THE WHOLE POINT. `doseId` is an
  // `intake_item_doses` row id — a SCHEDULE row, not an occurrence — so a daily
  // supplement unlogged for three days is the same id on all three tabs. Keying this
  // by dose id alone meant logging yesterday's forgotten dose ALSO struck today's row
  // off the list and, with nothing left to show, closed the sheet with a success
  // toast — the #280 false-confirmation this file's header says it never commits,
  // reached by the most ordinary use of the control. It reversed too, and `notes`
  // carried the same collision: a refusal earned on yesterday rendered under today's
  // row. One occurrence is one (day, dose) pair; nothing here may key on less.
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  useLayoutEffect(() => {
    if (focusReturnActivation != null && addFocusRef?.current)
      onReturnFocus?.(focusReturnActivation);
  }, [addFocusRef, focusReturnActivation, onReturnFocus]);
  // The last outcome per (day, dose) that did NOT resolve it — shown inline so the
  // reason the row is still there is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const day = selectedDay;

  const remaining = doses.filter(
    (d) => !resolved.has(occurrenceKey(today, d.doseId))
  );
  const pastSlots = useMemo(
    () =>
      new Map(
        pastDays.map((past) => [
          past.date,
          past.slots
            .map((slot) => ({
              ...slot,
              doses: slot.doses.filter(
                (d) => !resolved.has(occurrenceKey(past.date, d.doseId))
              ),
            }))
            .filter((slot) => slot.doses.length > 0),
        ])
      ),
    [pastDays, resolved]
  );

  // FUNCTIONAL, not `new Set(resolved)`. The past-day view is the first surface here
  // built for resolving SEVERAL doses in quick succession — and the bulk row calls this
  // with many ids at once — so two taps landing inside one render batch would have the
  // second overwrite the first from a stale closure: the first row reappears, and
  // tapping it again earns "Nothing left to log for that day." in error tone for a dose
  // that is correctly logged. `setNotes` beside it was already written this way.
  function markResolved(date: string, doseIds: readonly number[]): void {
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of doseIds) next.add(occurrenceKey(date, id));
      return next;
    });
  }

  // Nothing left ANYWHERE in the window is the only state that may close the sheet, and
  // it is asked from the COMMITTED `resolved` rather than inside the updater above —
  // an updater must stay pure (React may invoke it twice), and closing the sheet is the
  // least pure thing this component does. `resolved.size > 0` keeps it to days this
  // session actually cleared: a sheet that opened with something to show never closes
  // itself on mount.
  useEffect(() => {
    if (resolved.size === 0) return;
    const left =
      doses.some((d) => !resolved.has(occurrenceKey(today, d.doseId))) ||
      pastDays.some((past) =>
        past.slots.some((slot) =>
          slot.doses.some(
            (d) => !resolved.has(occurrenceKey(past.date, d.doseId))
          )
        )
      );
    if (!left) onDone();
  }, [resolved, doses, pastDays, today, onDone]);

  return (
    <div className="flex flex-col gap-3">
      {day !== today ? (
        <PastDayDoses
          date={day}
          slots={pastSlots.get(day) ?? []}
          notes={notes}
          onNote={(doseId, text) =>
            setNotes((prev) => ({
              ...prev,
              [occurrenceKey(day, doseId)]: text,
            }))
          }
          onResolved={(doseIds) => markResolved(day, doseIds)}
          subjectProfileId={subjectProfileId}
          profileToday={profileToday}
        />
      ) : remaining.length === 0 && !prn?.meds.length ? (
        <p
          data-testid="quick-entry-dose-empty"
          className="py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          Nothing left to confirm.
        </p>
      ) : remaining.length > 0 ? (
        <QuickEntryRowList testId="quick-entry-dose-list">
          {remaining.map((dose) => (
            /* THE SLOT IS STATED ONCE, ON THE CONTROL THAT WRITES IT (#4753,
               owner ruling 1). The row prints the dose name, so the payload is
               when it was owed: `8:00am · [Take]`. */
            <QuickEntryRow
              key={dose.doseId}
              testId={`quick-entry-dose-${dose.doseId}`}
              identity={dose.title}
              facts={
                <>
                  {dose.detail && (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {dose.detail}
                    </span>
                  )}
                  {notes[occurrenceKey(today, dose.doseId)] && (
                    <span
                      data-testid={`quick-entry-dose-note-${dose.doseId}`}
                      className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                    >
                      {notes[occurrenceKey(today, dose.doseId)]}
                    </span>
                  )}
                </>
              }
              actions={
                <DatedDoseControl
                  doseId={dose.doseId}
                  date={today === profileToday ? undefined : today}
                  profileToday={profileToday}
                  taken={false}
                  skipped={false}
                  variant="pill"
                  payload={dose.dueText}
                  rowLeaves
                  profileId={subjectProfileId}
                  onSettled={(result) => {
                    if (result.ok) markResolved(today, [dose.doseId]);
                    else
                      setNotes((prev) => ({
                        ...prev,
                        [occurrenceKey(today, dose.doseId)]: result.error,
                      }));
                  }}
                />
              }
            />
          ))}
        </QuickEntryRowList>
      ) : null}
      {prn && prn.meds.length > 0 && (
        <QuickLogPrnContent
          {...prn}
          profileId={subjectProfileId}
          date={day}
          onLogged={onPrnLogged}
        />
      )}
      {/* UNDER the due slots and the as-needed list, on every day the sheet stands
          on — the owner's ruling put it last because it is the only part of this body
          that is not about something owed. */}
      <EverythingElseFold
        items={others?.byDate[day] ?? []}
        date={day}
        liveDay={day === profileToday}
        nowHhmm={others?.nowHhmm ?? ""}
        tz={prn?.tz}
        subjectProfileId={subjectProfileId}
        onLogged={onPrnLogged}
      />
      {canAdd && onAdd ? (
        <div className="flex flex-wrap gap-2 border-t border-(--border) pt-3">
          <button
            ref={addFocusRef}
            type="button"
            className="btn-ghost"
            data-testid="quick-entry-add-medication"
            onClick={(event) => onAdd("medication", event.currentTarget)}
          >
            Add medication
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-testid="quick-entry-add-supplement"
            onClick={(event) => onAdd("supplement", event.currentTarget)}
          >
            Add supplement
          </button>
        </div>
      ) : null}
    </div>
  );
}

// One switched-to day's still-unresolved doses, as the SAME row this file draws for
// today (#5753 leg 1).
//
// THERE IS NO SECOND DOSE BODY ANY MORE. This branch used to be its own design: a
// heading per bucket, a whole-stack `OfferRow` above any bucket of two or more, and
// rows whose control mounted `compact` — so `DoseStatusControl` drew bare icon squares
// where today's row read `8:00am · Take`, and under each of them a paragraph explained
// that no amount was saved for the date. One body, two grammars, and the second one was
// the grammar #5521 had already deleted from today.
//
// THE BUCKET SURVIVES AS THE CHIP'S PAYLOAD, which is where the slot has belonged since
// #4753 ruling 1: the row prints the dose name, so the label says when it was owed
// (`Morning · Take`) and the sectioning that used to say it has nothing left to do. The
// bundle offer is #5663's receipt-and-toast contract rather than a second control row,
// and the assumed-amount sentence is a FACT beside the dose it qualifies.
//
// WHAT THE DAY STILL DECIDES, because it is the day's own doing and not a second
// policy: nothing is filtered by arrived slot (every bucket of a closed day has
// arrived), and the minute is REQUIRED (#5595) — `DatedDoseControl` reads that off the
// date it is handed, so this list states no rule of its own about it.
function PastDayDoses({
  date,
  slots,
  notes,
  onNote,
  onResolved,
  subjectProfileId,
  profileToday,
}: {
  date: string;
  // The live profile day, so the rows can tell a day that has ENDED from today (#4686).
  profileToday: string;
  slots: { bucket: TimeBucket; doses: QuickEntryPastDose[] }[];
  // Keyed by `occurrenceKey`, not by dose id — see the host's note on why a schedule
  // row id is not an occurrence.
  notes: Record<string, string>;
  onNote: (doseId: number, text: string) => void;
  onResolved: (doseIds: readonly number[]) => void;
  subjectProfileId?: number;
}) {
  if (slots.length === 0) {
    return (
      <p
        data-testid="quick-entry-dose-day-empty"
        className="py-2 text-sm text-slate-500 dark:text-slate-400"
      >
        Nothing left to log for this day.
      </p>
    );
  }

  return (
    <div data-testid="quick-entry-dose-day" data-date={date}>
      <QuickEntryRowList testId="quick-entry-dose-list">
        {slots.flatMap((slot) =>
          slot.doses.map((dose) => (
            <QuickEntryRow
              key={dose.doseId}
              testId={`quick-entry-dose-${dose.doseId}`}
              identity={dose.name}
              facts={
                <>
                  {dose.detail && (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {dose.detail}
                    </span>
                  )}
                  {dose.amountAssumed ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      Oldest known amount
                    </span>
                  ) : null}
                  {notes[occurrenceKey(date, dose.doseId)] && (
                    <span
                      data-testid={`quick-entry-dose-note-${dose.doseId}`}
                      className="block text-xs font-medium text-rose-600 dark:text-rose-400"
                    >
                      {notes[occurrenceKey(date, dose.doseId)]}
                    </span>
                  )}
                </>
              }
              actions={
                <DatedDoseControl
                  doseId={dose.doseId}
                  date={date}
                  profileToday={profileToday}
                  taken={false}
                  skipped={false}
                  variant="pill"
                  payload={TIME_BUCKET_LABELS[slot.bucket]}
                  itemName={dose.name}
                  rowLeaves
                  profileId={subjectProfileId}
                  onSettled={(result) => {
                    if (result.ok) onResolved([dose.doseId]);
                    else onNote(dose.doseId, result.error);
                  }}
                />
              }
            />
          ))
        )}
      </QuickEntryRowList>
    </div>
  );
}

// ── EVERYTHING ELSE (#5808, owner ruling 2026-09-10) ─────────────────────────
//
// ONE FOLDED ROW, and the fold is the bound. The body above it answers what is owed —
// today's arrived slots, the as-needed medications, a recent day's unresolved doses —
// so an active item that is simply not due had no row anywhere: an unscheduled
// supplement (never due, #5285, and this is where it is logged instead), a scheduled
// item wanted outside its slot, a second dose of one already taken. There is no search
// field: a profile's item list is small enough that expanding IS the search, and a box
// here would be a second catalog beside the intake pages' (#5344).
//
// ABSENT WHEN N IS ZERO — not an empty fold, and not a fold whose count disagrees with
// what expanding shows. Both halves read the SAME array, so the count cannot drift.
//
// THE APP'S ONE FOLD PRIMITIVE (#3677): a `<details>` with `motion-disclose`, so it
// opens without JavaScript, in-page find expands it, and the keyboard/AT semantics are
// the platform's. Uncontrolled and always closed on arrival — the sheet is opened for
// one write, and a remembered-open fold would put the whole catalog under the reader's
// finger before they asked.
function EverythingElseFold({
  items,
  date,
  liveDay,
  nowHhmm,
  tz,
  subjectProfileId,
  onLogged,
}: {
  items: QuickEntryOtherItem[];
  /** The day the sheet is standing on — the day every Take below states. */
  date: string;
  /** Whether that day is the profile's LIVE day, which is the only one with a "now". */
  liveDay: boolean;
  /** The SERVER's profile-local wall minute, which a live-day Take states. */
  nowHhmm: string;
  tz?: string;
  subjectProfileId?: number;
  onLogged?: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <Disclosure data-testid="quick-entry-others">
      <summary
        data-testid="quick-entry-others-summary"
        className="fold-control cursor-pointer list-none text-sm text-link marker:content-none"
      >
        Everything else ({items.length})
      </summary>
      <div className="mt-2">
        <QuickEntryRowList testId="quick-entry-others-list">
          {items.map((item) => (
            <OtherItemRow
              key={item.itemId}
              item={item}
              date={date}
              liveDay={liveDay}
              nowHhmm={nowHhmm}
              tz={tz}
              subjectProfileId={subjectProfileId}
              onLogged={onLogged}
            />
          ))}
        </QuickEntryRowList>
      </div>
    </Disclosure>
  );
}

// One catalog item offered for a one-tap dose on the sheet's day.
//
// IT POSTS `logHistoricalDose`, THE RECORD DOOR'S CORE — never `markDoseTaken`, which
// resolves an OCCURRENCE and therefore cannot serve an item that has none. That is the
// whole reason this row exists, so the write path is the row's first fact and not an
// implementation detail: the dated core takes an item, a dose row, a day and a stated
// minute, and files exactly one administration.
//
// WHERE THE MINUTE COMES FROM. The day is the surface's (#4738 ruling 1) and the time
// half is #4426's collapsed statement, in its usual two pieces. On the LIVE day the tap
// is one tap: it states the gather's server minute, or the minute already stated beside
// it when the reader opened the door and filled it. On any other day there is no "now"
// to state, so the tap OPENS the door and asks — the same grammar the as-needed row
// above it uses for a day that has ended (#5489 fix 2), rather than inventing a number.
//
// THE ROW DOES NOT LEAVE. Nothing here was owed, so logging it resolves nothing; the
// row stays, and the refresh the host already runs after an as-needed dose brings back
// its "taken 8:15am" fact — which is what makes a second dose one more tap.
function OtherItemRow({
  item,
  date,
  liveDay,
  nowHhmm,
  tz,
  subjectProfileId,
  onLogged,
}: {
  item: QuickEntryOtherItem;
  date: string;
  liveDay: boolean;
  nowHhmm: string;
  tz?: string;
  subjectProfileId?: number;
  onLogged?: () => void;
}) {
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const statement = useTimeStatement({
    day: date,
    tz,
    timeLabel: `Time ${item.name} was taken`,
    testId: `quick-entry-other-when-${item.itemId}`,
    disabled: busy,
  });

  async function log(time: string): Promise<void> {
    setBusy(true);
    try {
      const fd = stampLoggedVia(new FormData());
      fd.set("id", String(item.itemId));
      fd.set("dose_id", String(item.doseId));
      fd.set("date", date);
      fd.set("time", time);
      // The sheet's chosen subject (#4932), re-gated server-side by `gateItemProfile`
      // exactly as the record door's own add is. Absent on an acting-profile sheet.
      if (subjectProfileId != null) {
        fd.set("profile_id", String(subjectProfileId));
      }
      const result = await logHistoricalDose(fd);
      if (!result.ok) {
        // NEVER AN UNCONDITIONAL CONFIRM (#280), which is this file's own header rule:
        // a refusal — a paused item, a day outside the course — says so in place.
        setNote(result.error);
        toast(result.error, { tone: "error" });
        return;
      }
      setNote(null);
      toast(`Logged ${item.name}${item.detail ? ` · ${item.detail}` : ""}.`);
      // Rule 5: a statement is spent by the tap it answers, and only that one.
      statement.setOpen(false);
      statement.spend(time);
      onLogged?.();
    } catch {
      toast("Couldn't log that dose. Try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  function take(): void {
    // ONLY WHAT IS ON SCREEN (`TimeStatement` rule 2): a minute typed and then
    // dismissed is not a statement this tap may spend.
    const stated = statement.open ? statement.at : null;
    if (stated) {
      void log(stated);
      return;
    }
    if (liveDay && nowHhmm) {
      void log(nowHhmm);
      return;
    }
    statement.setOpen(true);
  }

  return (
    <QuickEntryRow
      testId={`quick-entry-other-${item.itemId}`}
      identity={item.name}
      facts={
        <>
          {item.takenAt && (
            <span
              data-testid={`quick-entry-other-taken-${item.itemId}`}
              className="block text-xs text-slate-500 dark:text-slate-400"
            >
              taken {item.takenAt}
            </span>
          )}
          {note && (
            <span
              data-testid={`quick-entry-other-note-${item.itemId}`}
              className="block text-xs font-medium text-rose-600 dark:text-rose-400"
            >
              {note}
            </span>
          )}
        </>
      }
      actions={
        <>
          {/* The chip's label is the PAYLOAD — the usual amount this tap writes — so
              the verb stays one word and never says "now" (#4753). An item with no
              recorded amount has nothing quantitative to promise, so it falls back to
              naming itself. */}
          <LabeledVerbChip
            label={item.detail || item.name}
            verb="Take"
            tone="neutral"
            onAct={take}
            disabled={busy}
            ariaLabel={`Take ${item.name}${item.detail ? ` · ${item.detail}` : ""}`}
            testId={`quick-entry-other-take-${item.itemId}`}
            clockDoor={statement.door}
          />
          {statement.reveal ? (
            <div className="w-full">{statement.reveal}</div>
          ) : null}
        </>
      }
    />
  );
}
