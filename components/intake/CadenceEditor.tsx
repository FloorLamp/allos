"use client";

import Chip from "@/components/Chip";
import DateField from "@/components/DateField";
import { WEEKDAYS_SHORT, weekdayOrder } from "@/lib/date";
import {
  CADENCE_KINDS,
  CADENCE_KIND_LABELS,
  type CadenceKind,
} from "@/lib/intake-cadence";

// The item-level CALENDAR control (issue #1602), shared by both intake forms: how
// often this item is on the schedule at all, independent of `condition` (which asks
// what KIND of day it is) and of `obligation` (which asks what is owed).
//
// It is deliberately three plain choices rather than a recurrence-rule builder. The
// prescriptions this exists for — weekly methotrexate/semaglutide/alendronate, an
// alternating-day anticoagulant, an every-72h patch — are all expressible as "these
// weekdays" or "every N days", and a general RRULE editor would buy the rest at the
// price of a control most people cannot fill in correctly. Rolling intervals ("72h
// after the LAST application") are deliberately out: dueness as a function of log
// history is a feedback loop, and it slots into this same field later.
export interface CadenceState {
  kind: CadenceKind;
  weekdays: number[];
  intervalDays: string;
  anchorDate: string;
}

export const emptyCadence = (): CadenceState => ({
  kind: "daily",
  weekdays: [],
  intervalDays: "",
  anchorDate: "",
});

// Weekday toggle chips, shared by the item cadence and the per-dose row override so a
// weekday means the same thing (and is picked the same way) in both places. Ordered by
// the profile's first-day-of-week for the same reason every other calendar surface is.
//
// FILTER CHIPS IN A WRAPPING ROW, NOT A SEGMENTED TRACK (#4505, after #5399). These
// sit in a gapped, wrapping strip, so they take the reach on every side and the gap
// pays for it: `gap-3.5` where the reach exists, because `gap-3` against 6px a side
// lands the extended targets on exactly zero margin. Marked `data-segmented-option`
// they had drawn the box's reserved border as a hairline and taken the block-only
// reach a tiled track gets, on a row that has gaps to spend.
export function WeekdayChips({
  value,
  onChange,
  weekStart = 0,
  idPrefix,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  weekStart?: number;
  idPrefix: string;
}) {
  const selected = new Set(value);
  return (
    <div
      data-testid={`${idPrefix}-weekdays`}
      className="flex flex-wrap gap-1.5 pointer-coarse:gap-3.5"
    >
      {weekdayOrder(weekStart).map((d) => {
        const on = selected.has(d);
        return (
          <Chip
            key={d}
            role="filter"
            pressed={on}
            testId={`${idPrefix}-weekday-${d}`}
            onClick={() =>
              onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())
            }
          >
            {WEEKDAYS_SHORT[d]}
          </Chip>
        );
      })}
    </div>
  );
}

export default function CadenceEditor({
  value,
  onChange,
  weekStart = 0,
}: {
  value: CadenceState;
  onChange: (next: CadenceState) => void;
  weekStart?: number;
}) {
  const set = (patch: Partial<CadenceState>) =>
    onChange({ ...value, ...patch });
  return (
    <div className="sm:col-span-2" data-testid="cadence-editor">
      <label className="mb-2 block section-label" htmlFor="cadence_kind">
        How often
      </label>
      <select
        id="cadence_kind"
        value={value.kind}
        onChange={(e) => set({ kind: e.target.value as CadenceKind })}
        className="input"
        aria-label="How often"
      >
        {CADENCE_KINDS.map((k) => (
          <option key={k} value={k}>
            {CADENCE_KIND_LABELS[k]}
          </option>
        ))}
      </select>

      {value.kind === "weekly" && (
        <div className="mt-2">
          <WeekdayChips
            value={value.weekdays}
            onChange={(weekdays) => set({ weekdays })}
            weekStart={weekStart}
            idPrefix="cadence"
          />
          {/* Failing open is the SAFE direction (see cadenceOn): a weekly item with no
              day chosen keeps behaving daily rather than silently never being due.
              Say so, so the state is understood rather than merely tolerated. */}
          {value.weekdays.length === 0 && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
              Pick at least one day — until then this stays due every day.
            </p>
          )}
        </div>
      )}

      {value.kind === "interval" && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Every N days
            <input
              type="number"
              min={1}
              step={1}
              value={value.intervalDays}
              onChange={(e) => set({ intervalDays: e.target.value })}
              className="input mt-1"
              aria-label="Interval in days"
              data-testid="cadence-interval-days"
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            Starting on
            <DateField
              value={value.anchorDate}
              onChange={(anchorDate) => set({ anchorDate })}
              inputClassName="mt-1"
              data-testid="cadence-anchor-date"
            />
          </label>
          <p className="text-xs text-slate-500 sm:col-span-2 dark:text-slate-400">
            Counted from the start date — nothing is due before it.
          </p>
        </div>
      )}
    </div>
  );
}
