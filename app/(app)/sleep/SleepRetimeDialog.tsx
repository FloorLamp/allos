"use client";

import { useState } from "react";
import ModalShell from "@/components/ModalShell";
import Button from "@/components/Button";
import TimeRangeFields from "@/components/TimeRangeFields";
import { useUndoableAction } from "@/components/useUndoableAction";
import { undoDelete } from "@/app/(app)/undo-actions";
import { overnightMinutesBetween } from "@/lib/activity-meta";
import {
  formatClockMinutes,
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { SLEEP_SKEW_HEDGE, sleepSkewSettledLine } from "@/lib/sleep-clock-skew";
import { formatHm, formatSleepWindow } from "@/lib/sleep-summary";
import type { SleepMoodHistoryRow } from "@/lib/sleep-summary";
import { retimeSleepSession } from "./actions";

// THE THIRD STATE FOR A CONTRADICTED NIGHT (issue #5021).
//
// #4299 left a hedged night two doors, and both of them lose something: keep the wrong
// instants, or delete the night. This is the door for the person who KNOWS when they
// slept. It states the window it is about to move and moves nothing until they answer.
//
// BOTH CLOCKS OPEN EMPTY, and that is the owner's ruling (2026-09-04 10:38 UTC), not an
// oversight. The detector's settled instant is real information and it is printed below
// as information — where the heart rate settled is sleep ONSET, and a person who lay
// awake first did not go to bed then. Putting it in the bed field would turn a
// measurement into a claim, which is the whole thing #4299 refused.
//
// WHAT IT DOES NOT DECIDE. A stated window of a different LENGTH is refused, because a
// different length has no single delta and the alternatives both fabricate the stage
// breakdown (lib/sleep-retime-db.ts). That refusal is the SERVER's and is not
// re-implemented here: the elapsed length of a night across a zone transition is not the
// difference of two wall clocks, so a local check would refuse a correct window on
// exactly the nights this app takes most care over. The stored length is offered as the
// ± shortcut instead, which is the affordance that makes the rule easy to satisfy.
export default function SleepRetimeDialog({
  row,
  dateLabel,
  tz,
  formatPrefs = DEFAULT_FORMAT_PREFS,
  onClose,
}: {
  row: SleepMoodHistoryRow;
  dateLabel: string;
  /** For the clock fields' own "now" shortcut; the WRITE resolves its clocks server-side. */
  tz: string;
  formatPrefs?: DisplayFormatPrefs;
  onClose: () => void;
}) {
  const announce = useUndoableAction();
  const [bedTime, setBedTime] = useState("");
  const [wakeTime, setWakeTime] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = row.sleepClaimedWindow;
  const sampleId = row.sleepSampleId;
  const span = overnightMinutesBetween(bedTime, wakeTime);
  const canSave = !pending && sampleId != null && span != null;

  async function save() {
    if (!canSave || sampleId == null) return;
    setPending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("sample_id", String(sampleId));
      fd.set("date", row.date);
      fd.set("bed_time", bedTime);
      fd.set("wake_time", wakeTime);
      const result = await retimeSleepSession(fd);
      // A refusal stays HERE rather than becoming a toast: every one of them is
      // something the person can answer by changing a clock, and a dialog that closes
      // on refusal makes them reopen it to find out what to change.
      if (result.error != null || result.undoId == null) {
        setError(result.error ?? "Couldn’t move those times. Try again.");
        return;
      }
      const undoId = result.undoId;
      announce({
        message: "Sleep times updated.",
        undo: {
          undoneMessage: "Restored.",
          run: async () => {
            const { ok } = await undoDelete(undoId);
            return ok ? { ok: true } : { ok: false, reason: "expired" };
          },
        },
      });
      onClose();
    } catch {
      setError("Couldn’t move those times. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalShell
      title={`Fix times for ${dateLabel}`}
      onClose={onClose}
      size="sm"
      closeDisabled={pending}
      testId="sleep-retime-dialog"
    >
      <div className="space-y-4">
        <div className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
          <p>{SLEEP_SKEW_HEDGE}</p>
          {stored && (
            <p data-testid="sleep-retime-stored">
              Stored as{" "}
              {formatSleepWindow(
                formatPrefs.timeFormat,
                stored.startMinutes,
                stored.endMinutes
              )}
              , {formatHm(stored.elapsedMin)}.
            </p>
          )}
          {row.sleepSettledMinutes != null && (
            <p data-testid="sleep-retime-settled">
              {sleepSkewSettledLine(
                formatClockMinutes(
                  formatPrefs.timeFormat,
                  row.sleepSettledMinutes
                )
              )}
            </p>
          )}
        </div>

        <TimeRangeFields
          idPrefix="sleep-retime"
          startTime={bedTime}
          endTime={wakeTime}
          tz={tz}
          timeError={false}
          // The stored length, so entering one clock offers the other exactly where the
          // move can accept it. Null would leave the person to hit it by arithmetic.
          derivableDurationMin={stored?.elapsedMin ?? null}
          startLabel="Bed time"
          endLabel="Wake time"
          overnight
          onStartTime={setBedTime}
          onEndTime={setWakeTime}
        />

        <p className="text-xs text-slate-500 dark:text-slate-400">
          The sleep stages move with the session. You can undo this.
        </p>

        {error && (
          <p
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="sleep-retime-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={!canSave}
            data-testid="sleep-retime-save"
          >
            {pending ? "Saving…" : "Save times"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
