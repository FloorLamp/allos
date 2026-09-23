"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
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
import Button from "@/components/Button";
import { useDoseDayResolution } from "@/components/medications/dose-day-settlement";
import {
  DOSE_ACTION_LABEL,
  DOSE_ACTION_NEUTRAL,
} from "@/components/medications/dose-action-styles";
import { TIME_BUCKET_LABELS } from "@/lib/intake-schedule";
import { hhmmFromMinutes } from "@/lib/date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  formatClockMinutes,
  formatClockValue,
  type TimeFormat,
} from "@/lib/format-date";
import { bulkLabel, namesPhrase } from "@/lib/usual-routine";
import {
  logHistoricalDose,
  type DoseStatusResult,
} from "@/app/(app)/nutrition/intake-actions";
import type {
  QuickEntryDose,
  QuickEntryOtherItem,
  QuickEntryOthers,
  QuickEntryPastDay,
  QuickEntryPrn,
} from "@/app/(app)/quick-entry-actions";
import type { DoseStatusOutcome, IntakeItemKind } from "@/lib/types";

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
// **It never unconditionally confirms.** A row states its receipt only when the write
// says it wrote; a refusal — a dose retired by a schedule edit, an item since paused —
// keeps offering the dose with the honest message beside it, because it is still due.
// Saying "Dose logged" there would be a false confirmation of a possibly-critical
// medication (the #280 defect).
//
// THE ROW STAYS (#5663 ruling 2). A landed take keeps its row, which states `Taken`
// (with the stated minute) beside a control showing its done state; the toast confirms
// it with Undo. The sheet never closes itself: you dismiss it when done.
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

// What this session wrote on one occurrence, and the wall time a take stated.
type Landed = { status: "taken" | "skipped"; at: string | null };
type LandedMap = ReadonlyMap<string, Landed>;

// Where an answered write leaves the row: resolved, clear again, or as it was.
function landedStatus(
  outcome: DoseStatusOutcome
): Landed["status"] | "clear" | null {
  switch (outcome) {
    case "logged":
    case "logged-off-day":
    case "already-taken":
      return "taken";
    case "skipped":
    case "already-skipped":
      return "skipped";
    case "cleared":
      return "clear";
    case "unchanged":
    case "inactive":
    case "stale-dose":
      return null;
  }
}

// The row's receipt (#5663 ruling 1): `Taken · 7:52 AM`, or `Taken` when no minute
// was stated, and `Skipped`.
function DoseReceipt({
  doseId,
  landed,
  timeFormat,
}: {
  doseId: number;
  landed: Landed | undefined;
  timeFormat: TimeFormat;
}): ReactNode {
  if (!landed) return null;
  const clock = formatClockValue(landed.at, timeFormat, "", "upper-space");
  return (
    <span
      data-testid={`quick-entry-dose-receipt-${doseId}`}
      className="block text-xs font-medium text-slate-700 dark:text-slate-200"
    >
      {landed.status === "skipped"
        ? "Skipped"
        : clock
          ? `Taken · ${clock}`
          : "Taken"}
    </span>
  );
}

export default function QuickDoseList({
  today,
  profileToday = today,
  doses,
  prn,
  pastDays,
  others,
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
  // What THIS overlay session wrote, per occurrence. Local rather than re-fetched: the
  // sheet is a transactional surface, and re-running the gather mid-list would reorder
  // rows under the user's finger.
  //
  // KEYED BY (DAY, DOSE), AND THAT IS THE WHOLE POINT. `doseId` is an
  // `intake_item_doses` row id — a SCHEDULE row, not an occurrence — so a daily
  // supplement unlogged for three days is the same id on all three tabs. Keying by dose
  // id alone once struck today's row when yesterday's was logged — the #280
  // false-confirmation this file's header says it never commits. `notes` carried the
  // same collision. One occurrence is one (day, dose) pair; nothing here may key on less.
  const [landed, setLanded] = useState<LandedMap>(() => new Map());
  useLayoutEffect(() => {
    if (focusReturnActivation != null && addFocusRef?.current)
      onReturnFocus?.(focusReturnActivation);
  }, [addFocusRef, focusReturnActivation, onReturnFocus]);
  // The last outcome per (day, dose) that did NOT land — shown inline so the reason
  // the dose is still offered is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const day = selectedDay;
  const { timeFormat } = useFormatPrefs();

  // FUNCTIONAL, not `new Map(landed)`. Two taps landing inside one render batch —
  // and the bulk row lands many ids at once — would otherwise have the second
  // overwrite the first from a stale closure.
  function land(
    date: string,
    doseIds: readonly number[],
    next: Landed | null
  ): void {
    setLanded((prev) => {
      const map = new Map(prev);
      for (const id of doseIds) {
        const key = occurrenceKey(date, id);
        if (next) map.set(key, next);
        else map.delete(key);
      }
      return map;
    });
  }

  function settleRow(
    date: string,
    doseId: number,
    result: DoseStatusResult,
    at: string | null
  ): void {
    if (!result.ok) {
      setNotes((prev) => ({
        ...prev,
        [occurrenceKey(date, doseId)]: result.error,
      }));
      return;
    }
    const status = landedStatus(result.outcome);
    if (status === "clear") land(date, [doseId], null);
    else if (status) land(date, [doseId], { status, at });
  }

  return (
    <div className="flex flex-col gap-3">
      {day !== today ? (
        <PastDayDoses
          date={day}
          slots={pastDays.find((past) => past.date === day)?.slots ?? []}
          landed={landed}
          notes={notes}
          onNote={(doseId, text) =>
            setNotes((prev) => ({
              ...prev,
              [occurrenceKey(day, doseId)]: text,
            }))
          }
          onSettled={(doseId, result, at) => settleRow(day, doseId, result, at)}
          onResolved={(doseIds, at) =>
            land(day, doseIds, { status: "taken", at })
          }
          subjectProfileId={subjectProfileId}
          profileToday={profileToday}
          timeFormat={timeFormat}
        />
      ) : doses.length === 0 && !prn?.meds.length ? (
        <p
          data-testid="quick-entry-dose-empty"
          className="py-2 text-sm text-slate-500 dark:text-slate-400"
        >
          Nothing left to confirm.
        </p>
      ) : doses.length > 0 ? (
        <QuickEntryRowList testId="quick-entry-dose-list">
          {doses.map((dose) => {
            const done = landed.get(occurrenceKey(today, dose.doseId));
            return (
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
                    <DoseReceipt
                      doseId={dose.doseId}
                      landed={done}
                      timeFormat={timeFormat}
                    />
                    {!done && notes[occurrenceKey(today, dose.doseId)] && (
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
                    taken={done?.status === "taken"}
                    skipped={done?.status === "skipped"}
                    variant="pill"
                    payload={dose.dueText}
                    announces
                    profileId={subjectProfileId}
                    onSettled={(result, at) =>
                      settleRow(today, dose.doseId, result, at)
                    }
                  />
                }
              />
            );
          })}
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

// One switched-to day's doses — those unresolved when the sheet opened — as the SAME
// row this file draws for today (#5753 leg 1).
//
// THERE IS NO SECOND DOSE BODY ANY MORE. This branch used to be its own design: a
// heading per bucket, a whole-stack `OfferRow` above any bucket of two or more, and
// rows whose control mounted `compact` — so `DoseStatusControl` drew bare icon squares
// where today's row read `8:00am · Take`, and under each of them a paragraph explained
// that no amount was saved for the date. One body, two grammars, and the second one was
// the grammar #5521 had already deleted from today.
//
// THE SLOT CAME BACK AS THE UNIT OF TIME (#5813), not as a second body: one header per
// slot states the time once for the whole act (see `PastSlot`), and the rows under it
// stay today's composition. The receipt is #5663's row line, and the assumed-amount
// sentence is a FACT beside the dose it qualifies.
//
// WHAT THE DAY STILL DECIDES: nothing is filtered by arrived slot (every bucket of a
// closed day has arrived), and a minute is still asked for (#5595) — by the slot, or
// by the row while the slot states none.
type PastRowProps = {
  date: string;
  // The live profile day, so the rows can tell a day that has ENDED from today (#4686).
  profileToday: string;
  timeFormat: TimeFormat;
  // Both keyed by `occurrenceKey`, not by dose id — see the host's note on why a
  // schedule row id is not an occurrence.
  landed: LandedMap;
  notes: Record<string, string>;
  onNote: (doseId: number, text: string) => void;
  onSettled: (
    doseId: number,
    result: DoseStatusResult,
    at: string | null
  ) => void;
  // A whole-slot Take landed these, at the slot's stated time.
  onResolved: (doseIds: readonly number[], at: string | null) => void;
  subjectProfileId?: number;
};

function PastDayDoses({
  slots,
  ...row
}: PastRowProps & { slots: QuickEntryPastDay["slots"] }) {
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
    <div data-testid="quick-entry-dose-day" data-date={row.date}>
      <QuickEntryRowList testId="quick-entry-dose-list">
        {slots.map((slot) => (
          <PastSlot key={slot.bucket} slot={slot} {...row} />
        ))}
      </QuickEntryRowList>
    </div>
  );
}

// ONE TIME PER SLOT (#5813, owner ruling 2026-09-10). On a past day the slot is the
// unit: its header states one time for the whole act, offers the profile's usual clock
// for it and "Don't know", and Take all posts that time on every row. The chips only
// fill the field; nothing writes until a Take. A row's own Take uses the slot's time
// once one is stated, and asks for its own while none is. Take all and the time cover
// only the doses still open; a landed row keeps its place with its receipt.
function PastSlot({
  date,
  slot,
  landed,
  notes,
  onNote,
  onSettled,
  onResolved,
  subjectProfileId,
  profileToday,
  timeFormat,
}: PastRowProps & { slot: QuickEntryPastDay["slots"][number] }) {
  const label = TIME_BUCKET_LABELS[slot.bucket];
  const testId = `quick-entry-dose-slot-${slot.bucket.replace(" ", "-")}`;
  const time = useTimeStatement({
    day: date,
    required: true,
    unknownLabel: "Don’t know",
    timeLabel: "Time",
    testId: `${testId}-when`,
  });
  const { resolveAll, bulkBlocked } = useDoseDayResolution({
    date,
    bulkFailureMessage: "Couldn't log those doses. Try again.",
    note: onNote,
    resolved: (doseIds) => onResolved(doseIds, time.at),
    profileId: subjectProfileId,
  });
  const open = slot.doses.filter(
    (dose) => !landed.has(occurrenceKey(date, dose.doseId))
  );
  const ids = open.map((dose) => dose.doseId);
  const usual = slot.usual;
  return (
    <>
      <li
        data-testid={testId}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
      >
        <div className="flex-auto font-medium text-slate-800 dark:text-slate-100">
          {label} · {slot.doses.length}
        </div>
        {open.length > 1 ? (
          <Button
            data-testid={`${testId}-takeall`}
            aria-label={`${bulkLabel("Take", open)}: ${namesPhrase(open.map((dose) => dose.name))}`}
            disabled={bulkBlocked(ids)}
            onClick={() => resolveAll(ids, time.at)}
          >
            {bulkLabel("Take", open)}
          </Button>
        ) : null}
        {open.length > 0 ? (
          <div className="flex w-full flex-wrap items-end gap-2">
            {time.reveal}
            {usual ? (
              <button
                type="button"
                data-testid={`${testId}-usual`}
                data-source={usual.source}
                onClick={() => time.fill(hhmmFromMinutes(usual.minute))}
                className={`${DOSE_ACTION_LABEL} ${DOSE_ACTION_NEUTRAL}`}
              >
                {usual.source === "recorded" ? "Usually" : label}{" "}
                {formatClockMinutes(timeFormat, usual.minute, "lower-nospace")}
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
      {slot.doses.map((dose) => {
        const done = landed.get(occurrenceKey(date, dose.doseId));
        return (
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
                <DoseReceipt
                  doseId={dose.doseId}
                  landed={done}
                  timeFormat={timeFormat}
                />
                {!done && notes[occurrenceKey(date, dose.doseId)] && (
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
                taken={done?.status === "taken"}
                skipped={done?.status === "skipped"}
                variant="pill"
                payload={label}
                itemName={dose.name}
                announces
                profileId={subjectProfileId}
                slot={time}
                onSettled={(result, at) => onSettled(dose.doseId, result, at)}
              />
            }
          />
        );
      })}
    </>
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

  // `consumed` is what the tap SPENT from the statement — null for the live day's
  // one-tap, which pays for nothing. Passing the posted minute instead would drop a
  // statement made beside a tap that never used it, and would do so exactly when the
  // reader had typed the current minute (`TimeStatement` rule 5).
  async function log(time: string, consumed: string | null): Promise<void> {
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
      // Rule 5: a statement is spent by the tap it answers, and only that one. The
      // reveal closes on the SAME event, because a spent statement is the only reason
      // there was to close it.
      if (consumed) statement.setOpen(false);
      statement.spend(consumed);
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
      void log(stated, stated);
      return;
    }
    if (liveDay && nowHhmm) {
      void log(nowHhmm, null);
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
            busy={busy}
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
