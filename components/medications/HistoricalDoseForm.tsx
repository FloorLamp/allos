"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
import WhenControl, { type WhenValue } from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm, statedInstantOnDate } from "@/lib/stated-time";
import InlineError from "@/components/InlineError";
import {
  logHistoricalDose,
  updateHistoricalDose,
} from "@/app/(app)/nutrition/intake-actions";

export interface HistoricalDoseOption {
  id: number;
  label: string;
  amount: string | null;
}

/**
 * One item a past dose may be logged against. The form takes a LIST and owns the
 * picker, which was spelled twice — the record door's launcher and the Supplements
 * tab's card — with the option list built two ways.
 */
export interface HistoricalDoseItem {
  id: number;
  name: string;
  doses: HistoricalDoseOption[];
  asNeeded: boolean;
  /** Bounded by a medication course? False for an item that keeps none (supplements). */
  courseBound: boolean;
}

// Backfill / amend one recorded dose. Shared by both intake surfaces since #1933, so
// its copy names the ITEM, not "the medication": the only medication-specific rule
// left is the course window, which only an item that HAS courses is bound by
// (`courseBound`).
//
// The date+time pair renders through the shared WhenControl (#2236 / #2228):
//
//   • BACKFILL is `state` mode with the time REQUIRED (decision 2): logging a past
//     dose is a new assertion that a dose happened, and naming when is the point.
//     The time still prefills from `defaultTime` so it costs no taps.
//   • AMEND is `correct` mode: "Not stated" is reachable and submits an empty time,
//     which the write path records as occurred_at = NULL — amending only the amount
//     of a dose whose intake time was never stated changes the amount and nothing
//     else. The time seeds from `editing.statedAt` (the row's occurred_at), NEVER
//     from recorded_at capture — a row with no stated intake time
//     opens with an EMPTY time field instead of laundering a filing timestamp into
//     an administration time (#2228's defect).
//
// The wire stays date + "HH:MM" (hidden inputs kept in sync with the pair): the
// action re-anchors the wall time against the submitted date in the profile's
// timezone, and the core enforces the pair rule again at the boundary.
export default function HistoricalDoseForm({
  items,
  minDate,
  maxDate,
  initialDate,
  defaultTime,
  editing,
  subjectProfileId,
  tz: tzProp,
  repeatAfterAdd = false,
  onSaved,
  onDone,
}: {
  /** In the order the mount wants them offered; one item renders no picker. */
  items: HistoricalDoseItem[];
  minDate?: string;
  maxDate: string;
  initialDate?: string;
  defaultTime: string;
  editing?: {
    logId: number;
    doseId: number;
    date: string;
    // The row's stated event instant (occurred_at, ISO UTC), or null = no intake
    // time was ever stated. Never a record-chain fallback.
    statedAt: string | null;
    amount: string | null;
  };
  /**
   * The SUBJECT this form writes, when that is not the acting profile: the ROW's
   * profile on a correction (#4009 item 1), and — since the #4693 amendment — the
   * CONTAINER's subject on an add mounted by a surface that names one profile
   * (`/medications/[id]` viewed cross-profile). The backfill add was acting-profile
   * only by owner ruling; that ruling is superseded on subject-scoped containers, so
   * both modes now carry the same field. Posted as `profile_id`, which is how this
   * repo spells a per-item write's subject, and gated server-side by
   * `gateItemProfile`. Absent on every single-subject mount, which is what makes the
   * gate fall back to the acting profile there.
   */
  subjectProfileId?: number;
  /**
   * The SUBJECT's timezone. A stated dose time is a wall clock on the subject's own
   * day, and `updateHistoricalDose` re-anchors it in the subject's zone — so a form
   * that collected it in the CAREGIVER's zone would shift the instant on save with
   * nothing edited. Defaults to the app-wide provider (the acting profile), which is
   * the same value for every single-subject mount.
   */
  tz?: string;
  /**
   * Keep an add form mounted for another entry. The record Add door uses this to
   * retain the chosen day while restoring the entry fields to their initial values.
   * Other add mounts and every edit keep their existing completion behavior.
   */
  repeatAfterAdd?: boolean;
  /** Runs after a successful write; defaults to `onDone` for existing mounts. */
  onSaved?: () => void;
  /** Dismisses the form (and remains the success callback when `onSaved` is absent). */
  onDone: () => void;
}) {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  const [itemId, setItemId] = useState(items[0]?.id ?? 0);
  const item = items.find((candidate) => candidate.id === itemId) ?? items[0];
  const doses = item?.doses ?? [];
  const first = doses[0];
  const initialDose = editing
    ? (doses.find((dose) => dose.id === editing.doseId) ?? {
        id: editing.doseId,
        label: "Recorded dose",
        amount: editing.amount,
      })
    : first;
  const [doseId, setDoseId] = useState(initialDose?.id ?? 0);
  const [amount, setAmount] = useState(
    editing?.amount ?? initialDose?.amount ?? ""
  );
  const [adjustSupply, setAdjustSupply] = useState(false);

  // SWITCHING THE ITEM RESETS THE DOSE AND ITS AMOUNT. The two wrappers this replaced
  // remounted the form on a `key` for that, throwing away the chosen date with it.
  function pickItem(nextId: number): void {
    const next = items.find((candidate) => candidate.id === nextId);
    if (!next) return;
    setItemId(nextId);
    setDoseId(next.doses[0]?.id ?? 0);
    setAmount(next.doses[0]?.amount ?? "");
  }
  const [when, setWhen] = useState<WhenValue>(() =>
    editing
      ? { date: editing.date, statedAt: editing.statedAt }
      : {
          date: initialDate ?? maxDate,
          statedAt:
            statedInstantOnDate(
              initialDate ?? maxDate,
              defaultTime,
              tz
            )?.toISOString() ?? null,
        }
  );
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();

  function resetAddEntry(): void {
    const resetItem = items[0];
    const resetDose = resetItem?.doses[0];
    setItemId(resetItem?.id ?? 0);
    setDoseId(resetDose?.id ?? 0);
    setAmount(resetDose?.amount ?? "");
    setAdjustSupply(false);
    setWhen((current) => ({
      date: current.date,
      statedAt:
        statedInstantOnDate(current.date, defaultTime, tz)?.toISOString() ??
        null,
    }));
  }

  if (!item || !initialDose) return null;
  const { name: itemName, asNeeded, courseBound } = item;

  return (
    <form
      action={async (formData) => {
        setError(null);
        const result = editing
          ? await updateHistoricalDose(formData)
          : await logHistoricalDose(stampLoggedVia(formData));
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast(
          editing
            ? `Updated dose of ${itemName}.`
            : `Logged past dose of ${itemName}.`
        );
        if (!editing && repeatAfterAdd) resetAddEntry();
        (onSaved ?? onDone)();
      }}
      className="mt-3 space-y-3 border-y border-black/5 py-3 dark:border-white/5"
      data-testid="historical-dose-form"
    >
      <input type="hidden" name="id" value={itemId} />
      {subjectProfileId != null ? (
        <input type="hidden" name="profile_id" value={subjectProfileId} />
      ) : null}
      {editing ? (
        <input type="hidden" name="log_id" value={editing.logId} />
      ) : null}
      <input type="hidden" name="date" value={when.date} />
      <input type="hidden" name="time" value={statedHhmm(when.statedAt, tz)} />
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && items.length > 1 ? (
          <div>
            {/* Named for what it selects rather than "Item": a record filtered by item
                renders its own control, and two named "Item" are indistinguishable. */}
            <label className="label" htmlFor="historical-dose-item">
              Item to log against
            </label>
            <select
              id="historical-dose-item"
              className="input"
              value={itemId}
              data-testid="historical-dose-item-picker"
              onChange={(event) => pickItem(Number(event.target.value))}
            >
              {items.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {!editing && doses.length > 1 ? (
          <div>
            <label className="label" htmlFor={`history-dose-${itemId}`}>
              {asNeeded ? "Dose" : "Scheduled dose"}
            </label>
            <select
              id={`history-dose-${itemId}`}
              name="dose_id"
              className="input"
              value={doseId}
              onChange={(event) => {
                const nextId = Number(event.target.value);
                setDoseId(nextId);
                setAmount(
                  doses.find((dose) => dose.id === nextId)?.amount ?? ""
                );
              }}
            >
              {doses.map((dose) => (
                <option key={dose.id} value={dose.id}>
                  {dose.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="dose_id" value={doseId} />
        )}
        <div>
          <label className="label" htmlFor={`history-amount-${itemId}`}>
            Amount
          </label>
          <input
            id={`history-amount-${itemId}`}
            name="amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="input"
            placeholder="e.g. 5 mg"
          />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Taken</span>
          <WhenControl
            mode={editing ? "correct" : "state"}
            grain="minute"
            value={when}
            onChange={setWhen}
            tz={tz}
            timeRequired={!editing}
            minDate={minDate}
            maxDate={maxDate}
            dateLabel="Date"
            timeLabel="Time taken"
            testId="historical-dose"
          />
        </div>
      </div>

      {!editing ? (
        <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            name="adjust_supply"
            value="1"
            checked={adjustSupply}
            onChange={(event) => setAdjustSupply(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded-sm border-slate-300 text-brand-600 dark:border-slate-600"
          />
          <span>
            Adjust current supply
            <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
              Subtract this dose from units on hand. Leave off if inventory has
              since been reconciled.
            </span>
          </span>
        </label>
      ) : null}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {editing
          ? `Changing this record won’t change current supply. ${
              !courseBound
                ? "It won’t change the schedule either."
                : asNeeded
                  ? "An earlier date will move the medication start date back to match."
                  : "The date must remain within a medication course."
            }`
          : !courseBound
            ? "Choose any past date that isn’t in the future. This updates adherence history for that date and won’t change the schedule."
            : asNeeded
              ? "Choose any past date. If it is before the current start date, the start date will move back to match. This records a separate administration in dose history."
              : "The date must fall within a medication course and cannot be in the future. This updates adherence history for that date."}
      </p>
      <InlineError>{error}</InlineError>
      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Saving…">
          {editing ? "Save changes" : "Save dose"}
        </SubmitButton>
        <button type="button" onClick={onDone} className="btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
