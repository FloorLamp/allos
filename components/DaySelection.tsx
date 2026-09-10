"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Button from "@/components/Button";
import CheckboxControl from "@/components/CheckboxControl";
import DateField from "@/components/DateField";
import WhenControl from "@/components/WhenControl";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm, whenOnDay, type WhenValue } from "@/lib/stated-time";
import {
  deleteLedgerSelection,
  moveLedgerSelectionToDay,
  setLedgerSelectionTime,
  type LedgerSelectionEditResult,
} from "@/app/(app)/nutrition/intake-actions";

// SELECTION MODE FOR ONE DAY (#4118, taken up by #5618 ruling 4).
//
// A day reconstructed late is wrong the SAME way on every row it holds — the reported
// case is a whole morning logged the next afternoon — so the repair is one gesture over
// many rows, not the ⋯ menu N times. This is that gesture, and it is ONE component: the
// Nutrition day's ledger and the record's day view both mount it, so the grammar #4118
// ruled ("/history may inherit the grammar later") is inherited rather than re-grown.
// A second implementation on the record was the thing this replaces before it existed.
//
// WHAT IT IS NOT: a write path. Every verb posts one of the three Server Actions the
// ledger already had, and each of those walks every named row through the correction
// core its own domain owns (lib/day-ledger-edit.ts). There is no bulk UPDATE anywhere
// beneath this file, and both pages therefore repair a serving or a taken supplement
// dose through exactly the same rules a single-row correction gets — including the
// re-derivation that makes the ids a surface names an upper bound and never an
// instruction. That is why the record can offer this at all without a core of its own.
//
// WHAT DIFFERS BETWEEN THE TWO MOUNTS is one thing, and the ruling names it: where
// "Move to day…" gets its day from. The ledger offers its own page's day picker, which
// is seven days wide; the record takes ANY real past day through a date field, because
// every core behind this accepts any real past day (#4424/#4754) and the record is the
// surface you open precisely when the row belongs somewhere further back. The list was
// always THE OFFER AND NEVER THE GATE, so widening it on one page adds no reach the
// other page's server did not already have.

/** Which of the two id spaces a picked row lives in — the wire's two fields. */
export type PickKind = "servings" | "doses";

/** Where "Move to day…" gets the day it moves to. */
export type MoveTarget =
  /** The mounting page's own day offer, verbatim. Empty disables the verb. */
  | { kind: "days"; days: { date: string; label: string }[] }
  /** Any real past day, typed or picked. `max` is the subject's own today. */
  | { kind: "date"; max: string };

export interface DaySelectionConfig {
  /** The day whose rows these are. Posted with every batch; the core re-derives it. */
  date: string;
  /**
   * WHOSE rows (#4009 item 1). One batch names ONE subject, because `gateItemProfile`
   * gates one posted `profile_id` — so a surface with several profiles' rows in view
   * offers boxes on this one's only. Omitted on a single-subject page, where the
   * action's acting-profile fallback is the same answer and posting it adds nothing.
   */
  profileId?: number;
  /** `ledger` / `history` — the page's own testid stem, so neither page's ids move. */
  testIdPrefix: string;
  /** Whether this day holds anything a selection could act on at all. */
  selectable: boolean;
  moveTarget: MoveTarget;
}

interface DaySelectionValue extends DaySelectionConfig {
  selecting: boolean;
  picked: Record<PickKind, number[]>;
  pickedCount: number;
  enter: () => void;
  leave: () => void;
  togglePick: (kind: PickKind, id: number) => void;
}

// NULL IS A REAL STATE, not a missing provider: "this surface has no selection mode".
// The record mounts the same three pieces on its feed and its day view, and only the
// day view has a single day for a batch to name — so the feed passes no config and all
// three render nothing, rather than the page growing a second arrangement of them.
const DaySelectionContext = createContext<DaySelectionValue | null>(null);

/**
 * The mode's state, spanning whatever the page puts between its Select control and its
 * rows. It is a provider rather than one component because the two mounts hang the
 * three pieces off different frames: the ledger's toggle sits in its section header and
 * the record's in the day bar, several server-rendered layers above the rows.
 */
export function DaySelectionProvider({
  config,
  children,
}: {
  config: DaySelectionConfig | null;
  children: ReactNode;
}) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Record<PickKind, number[]>>(() => ({
    servings: [],
    doses: [],
  }));

  const value: DaySelectionValue | null = config && {
    ...config,
    selecting,
    picked,
    pickedCount: picked.servings.length + picked.doses.length,
    enter: () => setSelecting(true),
    leave: () => {
      setSelecting(false);
      setPicked({ servings: [], doses: [] });
    },
    togglePick: (kind, id) =>
      setPicked((prev) => {
        const list = prev[kind];
        return {
          ...prev,
          [kind]: list.includes(id)
            ? list.filter((x) => x !== id)
            : [...list, id],
        };
      }),
  };

  return (
    <DaySelectionContext.Provider value={value}>
      {children}
    </DaySelectionContext.Provider>
  );
}

/**
 * Enter or leave the mode. Absent entirely on a day with nothing selectable — an
 * affordance whose every target is absent is a lie the surface tells.
 */
export function DaySelectToggle() {
  const value = useContext(DaySelectionContext);
  if (!value?.selectable) return null;
  return (
    <Button
      data-testid={`${value.testIdPrefix}-select-toggle`}
      onClick={() => (value.selecting ? value.leave() : value.enter())}
    >
      {value.selecting ? "Cancel" : "Select"}
    </Button>
  );
}

/** The box a selectable row carries while the mode is on, and nothing otherwise. */
export function DayPickBox({
  kind,
  id,
  label,
}: {
  kind: PickKind;
  id: number;
  label: string;
}) {
  const value = useContext(DaySelectionContext);
  if (!value?.selecting) return null;
  return (
    <CheckboxControl
      label={label}
      checked={value.picked[kind].includes(id)}
      onChange={() => value.togglePick(kind, id)}
      data-testid={`${value.testIdPrefix}-pick-${
        kind === "servings" ? "serving" : "dose"
      }-${id}`}
    />
  );
}

/**
 * The count and the three verbs, inline under the page's own chrome — a MODE, not a
 * form, which is why it is not in the sheet host every form on these pages opens into.
 */
export function DaySelectionBar() {
  const value = useContext(DaySelectionContext);
  if (!value?.selecting) return null;
  return <SelectionVerbs value={value} />;
}

/** The rows one batch names, in the two id spaces the correction cores take. */
export interface LedgerBatchTarget {
  /** The day whose rows these are. The core re-derives it and narrows to it. */
  date: string;
  /** The subject, where the surface holds several (#4009 item 1). */
  profileId?: number;
  /** `food_log_events.id` for each serving. */
  servings: readonly number[];
  /** `intake_item_logs.id` for each taken dose. */
  doses: readonly number[];
}

/**
 * POST ONE BATCH AND SAY WHAT LANDED — the whole of what a surface needs to drive the
 * three Server Actions, and deliberately the only spelling of it.
 *
 * The action answers with the rows it wrote and every row it refused, each carrying the
 * reason its own core gave, so a batch that half-lands says so rather than confirming
 * all of it (#232's contract, at batch grain). The rows themselves come back from the
 * server revalidation the action ran.
 *
 * A HOOK RATHER THAN A FUNCTION because the wording is a toast and the in-flight state
 * is a render, and both belong to whichever surface is posting. Selection mode's bar is
 * one caller; the record's bundle row (#5618 ruling 5) is the other — one composed act
 * is a fixed selection of exactly these two id spaces, so it drives the same three
 * actions over the same cores rather than growing a fourth verb of its own.
 *
 * Answers whether the batch LANDED, which is the one thing the caller has to branch on:
 * selection mode leaves the mode, a bundle row closes its sheet.
 */
export function useLedgerBatch(): {
  busy: boolean;
  run: (
    verb: "Updated" | "Removed",
    action: (fd: FormData) => Promise<LedgerSelectionEditResult>,
    target: LedgerBatchTarget,
    extra?: Record<string, string>
  ) => Promise<boolean>;
} {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (verb, action, target, extra) => {
      const fd = new FormData();
      fd.set("date", target.date);
      if (target.profileId !== undefined)
        fd.set("profile_id", String(target.profileId));
      fd.set("serving_ids", target.servings.join(","));
      fd.set("dose_log_ids", target.doses.join(","));
      for (const [key, value] of Object.entries(extra ?? {}))
        fd.set(key, value);
      setBusy(true);
      try {
        const result = await action(fd);
        if (!result.ok) {
          toast(result.error, { tone: "error" });
          return false;
        }
        if (result.applied === 0) {
          toast(result.refused[0]?.reason ?? "Nothing changed.", {
            tone: "error",
          });
          return false;
        }
        toast(
          result.refused.length === 0
            ? `${verb} ${result.applied} ${result.applied === 1 ? "row" : "rows"}.`
            : `${verb} ${result.applied} of ${result.applied + result.refused.length} — ${result.refused[0]!.reason}`,
          result.refused.length === 0 ? undefined : { tone: "error" }
        );
        return true;
      } catch {
        toast("Something went wrong — reload to see what changed.", {
          tone: "error",
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

/**
 * THE ONE `WhenControl` MOUNT ON THE AFTER-THE-FACT CORRECTION PATH.
 *
 * #4426 keeps this composition where it is — the shared time statement tells the time
 * AT a tap, and this is the correction people reach for afterwards by naming rows and
 * asking for it. What #5618 ruling 5 adds is a second surface asking the same question
 * of a FIXED selection: a composed act is a selection nobody had to make by hand, so
 * its Edit is this control over the act's members. It lives here rather than growing a
 * second mount on the record, exactly as ruling 4's Set time… moved here rather than
 * being re-grown — one mount for every surface that corrects a batch.
 *
 * THE DAY IS FIXED to the one being read (min === max), so the control renders it as
 * text and the pair rule holds trivially. The wall clock is what travels; the core
 * re-anchors it on that day, so a time that has not happened yet is refused THERE by
 * the same gate every other stated instant passes rather than talked out of here.
 * Re-dating is Move to day…'s question, and giving this a day picker too would be two
 * answers to one.
 */
export function LedgerBatchWhen({
  date,
  testId,
  timeLabel,
  applyTestId,
  applyLabel = "Apply",
  busy,
  onApply,
}: {
  /** The day the rows sit on — the control's floor, ceiling and rendered text. */
  date: string;
  /** The `WhenControl` id stem; its time input is `${testId}-time`. */
  testId: string;
  /** The visible label on the control's time field. */
  timeLabel: string;
  applyTestId: string;
  applyLabel?: string;
  /** Whether a batch this control's host started is still in flight. */
  busy: boolean;
  /** The stated profile-local "HH:MM" the host posts as the batch's `time`. */
  onApply: (hhmm: string) => void;
}) {
  const tz = useTimezone();
  const [when, setWhen] = useState<WhenValue>(() => whenOnDay(date, tz));
  return (
    <>
      <WhenControl
        mode="state"
        grain="minute"
        timeRequired
        value={when}
        onChange={setWhen}
        minDate={date}
        maxDate={date}
        timeLabel={timeLabel}
        testId={testId}
      />
      <Button
        data-testid={applyTestId}
        disabled={busy || when.statedAt === null}
        onClick={() => {
          if (when.statedAt === null) return;
          onApply(statedHhmm(when.statedAt, tz));
        }}
      >
        {applyLabel}
      </Button>
    </>
  );
}

// The verbs' own state — which sheet is open, what it holds, whether a batch is in
// flight — lives BELOW the mode's gate, so leaving selection discards a half-filled
// sheet by unmounting it rather than by remembering to clear four things.
function SelectionVerbs({ value }: { value: DaySelectionValue }) {
  const {
    date,
    profileId,
    testIdPrefix,
    moveTarget,
    picked,
    pickedCount,
    leave,
  } = value;
  const confirm = useConfirm();
  const { busy, run } = useLedgerBatch();
  const [sheet, setSheet] = useState<"time" | "day" | null>(null);
  const [batchDay, setBatchDay] = useState("");

  // The mode's own wrapper around the shared poster: same batch, and leaving selection
  // is what this surface does with a landing.
  async function runBatch(
    verb: "Updated" | "Removed",
    action: (fd: FormData) => Promise<LedgerSelectionEditResult>,
    extra: Record<string, string>
  ): Promise<void> {
    const landed = await run(
      verb,
      action,
      { date, profileId, servings: picked.servings, doses: picked.doses },
      extra
    );
    if (landed) leave();
  }

  async function removeSelection(): Promise<void> {
    // ONE confirmation for the batch (the ruling). The per-row ⋯ removal offers an Undo
    // toast instead; a batch trades that for the question asked once, and the rows are
    // still recoverable from the Trash, which is where both paths' captures land.
    const ok = await confirm({
      title: `Remove ${pickedCount} ${pickedCount === 1 ? "row" : "rows"}?`,
      message: "They move to the Trash, where they can be restored.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await runBatch("Removed", deleteLedgerSelection, {});
  }

  const noDayToMoveTo =
    moveTarget.kind === "days" && moveTarget.days.length === 0;

  return (
    <div
      data-testid={`${testIdPrefix}-selection-bar`}
      className="flex flex-wrap items-center gap-2 rounded-md border border-(--divider) bg-slate-50 px-3 py-2 dark:bg-slate-900"
    >
      <span
        data-testid={`${testIdPrefix}-selection-count`}
        className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200"
      >
        {pickedCount} selected
      </span>
      <Button
        data-testid={`${testIdPrefix}-selection-set-time`}
        disabled={pickedCount === 0 || busy}
        onClick={() => setSheet(sheet === "time" ? null : "time")}
      >
        Set time…
      </Button>
      <Button
        data-testid={`${testIdPrefix}-selection-move-day`}
        disabled={pickedCount === 0 || busy || noDayToMoveTo}
        onClick={() => setSheet(sheet === "day" ? null : "day")}
      >
        Move to day…
      </Button>
      <Button
        data-testid={`${testIdPrefix}-selection-delete`}
        disabled={pickedCount === 0 || busy}
        onClick={() => void removeSelection()}
      >
        Delete
      </Button>
      {sheet === "time" && (
        <span className="flex items-center gap-2">
          {/* ONE time for the batch, in the app's one time vocabulary — and the same
              control the record's bundle row opens, above. */}
          <LedgerBatchWhen
            date={date}
            testId={`${testIdPrefix}-selection-when`}
            timeLabel="Time for the selected rows"
            applyTestId={`${testIdPrefix}-selection-time-apply`}
            busy={busy}
            onApply={(time) =>
              void runBatch("Updated", setLedgerSelectionTime, { time })
            }
          />
        </span>
      )}
      {sheet === "day" && (
        <span className="flex items-center gap-2">
          {moveTarget.kind === "days" ? (
            <select
              aria-label="Day to move the selected rows to"
              data-testid={`${testIdPrefix}-selection-day-select`}
              className="input"
              value={batchDay}
              onChange={(event) => setBatchDay(event.target.value)}
            >
              <option value="">Choose a day…</option>
              {moveTarget.days.map((day) => (
                <option key={day.date} value={day.date}>
                  {day.label}
                </option>
              ))}
            </select>
          ) : (
            // ANY REAL PAST DAY (#5618 ruling 4), through the field the app already
            // uses to name one. Bounded forward at the subject's own today because
            // that is the server's whole remaining rule; there is no floor, so the
            // day a row actually belongs to is reachable however far back it is.
            <>
              <label
                className="sr-only"
                htmlFor={`${testIdPrefix}-selection-day-field`}
              >
                Day to move the selected rows to
              </label>
              <DateField
                value={batchDay}
                onChange={setBatchDay}
                max={moveTarget.max}
                id={`${testIdPrefix}-selection-day-field`}
                data-testid={`${testIdPrefix}-selection-day-field`}
                inputClassName="w-40"
              />
            </>
          )}
          <Button
            data-testid={`${testIdPrefix}-selection-day-apply`}
            disabled={busy || batchDay === ""}
            onClick={() =>
              void runBatch("Updated", moveLedgerSelectionToDay, {
                to_date: batchDay,
              })
            }
          >
            Apply
          </Button>
        </span>
      )}
    </div>
  );
}
