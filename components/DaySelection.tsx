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
  const toast = useToast();
  const confirm = useConfirm();
  const tz = useTimezone();
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<"time" | "day" | null>(null);
  // THE ONE "WHEN" CONTROL (#2236/#3273), with its day FIXED to the one being read:
  // min === max, so it renders the day as text and the pair rule holds trivially. The
  // batch never re-dates through this control — Move to day… is the other verb, and
  // giving Set time… a day picker too would be two answers to one question.
  const [batchWhen, setBatchWhen] = useState<WhenValue>(() =>
    whenOnDay(date, tz)
  );
  const [batchDay, setBatchDay] = useState("");

  // Post one batch and SAY WHAT LANDED. The action answers with the rows it wrote and
  // every row it refused, each carrying the reason its own core gave — so a batch that
  // half-lands says so rather than confirming all of it (#232's contract, at batch
  // grain). The rows themselves come back from the server revalidation the action ran.
  async function runBatch(
    verb: "Updated" | "Removed",
    action: (fd: FormData) => Promise<LedgerSelectionEditResult>,
    extra: Record<string, string>
  ): Promise<void> {
    const fd = new FormData();
    fd.set("date", date);
    if (profileId !== undefined) fd.set("profile_id", String(profileId));
    fd.set("serving_ids", picked.servings.join(","));
    fd.set("dose_log_ids", picked.doses.join(","));
    for (const [key, value] of Object.entries(extra)) fd.set(key, value);
    setBusy(true);
    try {
      const result = await action(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      if (result.applied === 0) {
        toast(result.refused[0]?.reason ?? "Nothing changed.", {
          tone: "error",
        });
        return;
      }
      toast(
        result.refused.length === 0
          ? `${verb} ${result.applied} ${result.applied === 1 ? "row" : "rows"}.`
          : `${verb} ${result.applied} of ${result.applied + result.refused.length} — ${result.refused[0]!.reason}`,
        result.refused.length === 0 ? undefined : { tone: "error" }
      );
      leave();
    } catch {
      toast("Something went wrong — reload to see what changed.", {
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
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
          {/* ONE time for the batch, in the app's one time vocabulary. The wall
              clock is what travels; the core re-anchors it on the day being
              rendered, so a time that has not happened yet is refused THERE by the
              same gate every other stated instant passes, rather than talked out
              of here. */}
          <WhenControl
            mode="state"
            grain="minute"
            timeRequired
            value={batchWhen}
            onChange={setBatchWhen}
            minDate={date}
            maxDate={date}
            timeLabel="Time for the selected rows"
            testId={`${testIdPrefix}-selection-when`}
          />
          <Button
            data-testid={`${testIdPrefix}-selection-time-apply`}
            disabled={busy || batchWhen.statedAt === null}
            onClick={() =>
              void runBatch("Updated", setLedgerSelectionTime, {
                time: statedHhmm(batchWhen.statedAt, tz),
              })
            }
          >
            Apply
          </Button>
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
