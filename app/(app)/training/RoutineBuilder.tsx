"use client";

import { useState } from "react";
import { IconPlus, IconX, IconTrash } from "@tabler/icons-react";
import type { MuscleRegion } from "@/lib/lifts";
import { REGION_SCOPES } from "@/lib/lifts";
import { deriveFocusFromCandidates } from "@/lib/routine-derive";
import type { RoutineWithDays } from "@/lib/types";
import Combobox from "@/components/Combobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { createRoutineAction, updateRoutineAction } from "./actions";

// A single slot being authored. Sets/reps are kept as strings for the controlled
// number inputs; they're parsed + validated on submit. `draft` is the in-progress
// candidate typed into the combobox, never part of the payload.
interface SlotDraft {
  candidates: string[];
  sets: string;
  repMin: string;
  repMax: string;
  draft: string;
}
interface DayDraft {
  label: string;
  focus: MuscleRegion[];
  // Once the user toggles a focus chip, we stop auto-deriving focus from the day's
  // exercises so their manual choice sticks (the focus stays "derived, editable").
  focusTouched: boolean;
  slots: SlotDraft[];
}

const emptySlot = (): SlotDraft => ({
  candidates: [],
  sets: "3",
  repMin: "8",
  repMax: "12",
  draft: "",
});
const emptyDay = (n: number): DayDraft => ({
  label: `Day ${n}`,
  focus: [],
  focusTouched: false,
  slots: [emptySlot()],
});

function daysFromRoutine(routine: RoutineWithDays): DayDraft[] {
  return routine.days.map((d) => ({
    label: d.label,
    focus: d.focus,
    focusTouched: true, // preserve the stored focus on edit
    slots: d.slots.map((s) => ({
      candidates: s.candidates,
      sets: String(s.sets),
      repMin: String(s.rep_min),
      repMax: String(s.rep_max),
      draft: "",
    })),
  }));
}

// Custom-routine builder. Create mode when `editRoutine` is absent, else edit +
// replace. `onDone` closes the host modal after a successful save. Leaves layout room
// for the Restart-cycle action and cycle_weeks field (both land in #741) — neither is
// authored here.
export default function RoutineBuilder({
  liftOptions,
  editRoutine,
  onDone,
}: {
  liftOptions: string[];
  editRoutine?: RoutineWithDays;
  onDone?: () => void;
}) {
  const [name, setName] = useState(editRoutine?.name ?? "");
  // Optional mesocycle length in weeks (#741) — blank = no cycle. The last week of
  // the cycle is the deload week.
  const [cycleWeeks, setCycleWeeks] = useState(
    editRoutine?.cycle_weeks != null ? String(editRoutine.cycle_weeks) : ""
  );
  const [days, setDays] = useState<DayDraft[]>(
    editRoutine ? daysFromRoutine(editRoutine) : [emptyDay(1)]
  );
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Immutably update one day, re-deriving its focus from the current slots unless the
  // user has manually touched the focus chips.
  function patchDay(di: number, fn: (d: DayDraft) => DayDraft) {
    setDays((ds) =>
      ds.map((d, i) => {
        if (i !== di) return d;
        const next = fn(d);
        if (!next.focusTouched) {
          next.focus = deriveFocusFromCandidates(
            next.slots.map((s) => s.candidates)
          );
        }
        return next;
      })
    );
  }
  function patchSlot(di: number, si: number, fn: (s: SlotDraft) => SlotDraft) {
    patchDay(di, (d) => ({
      ...d,
      slots: d.slots.map((s, i) => (i === si ? fn(s) : s)),
    }));
  }

  function addCandidate(di: number, si: number, name: string) {
    const v = name.trim();
    if (!v) return;
    patchSlot(di, si, (s) =>
      s.candidates.some((c) => c.toLowerCase() === v.toLowerCase())
        ? { ...s, draft: "" }
        : { ...s, candidates: [...s.candidates, v], draft: "" }
    );
  }

  function toggleFocus(di: number, region: MuscleRegion) {
    setDays((ds) =>
      ds.map((d, i) =>
        i === di
          ? {
              ...d,
              focusTouched: true,
              focus: d.focus.includes(region)
                ? d.focus.filter((r) => r !== region)
                : REGION_SCOPES.filter(
                    (r) => d.focus.includes(r) || r === region
                  ),
            }
          : d
      )
    );
  }

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Give the routine a name.");
      return;
    }
    for (const d of days) {
      if (!d.label.trim()) {
        setError("Every day needs a label.");
        return;
      }
      if (d.slots.length === 0) {
        setError(`“${d.label.trim()}” needs at least one exercise slot.`);
        return;
      }
      for (const s of d.slots) {
        if (s.candidates.length === 0) {
          setError(
            `Every slot in “${d.label.trim()}” needs at least one exercise.`
          );
          return;
        }
      }
    }

    // Blank or non-positive ⇒ null (no cycle). validateRoutineInput clamps 1–52.
    const cw = Math.round(Number(cycleWeeks));
    const parsedCycle = cycleWeeks.trim() && cw >= 1 ? cw : null;

    const payload = {
      name: name.trim(),
      cycleWeeks: parsedCycle,
      days: days.map((d) => ({
        label: d.label.trim(),
        focus: d.focus,
        slots: d.slots.map((s) => ({
          candidates: s.candidates,
          sets: Math.max(1, Math.round(Number(s.sets) || 1)),
          repMin: Math.max(1, Math.round(Number(s.repMin) || 1)),
          repMax: Math.max(1, Math.round(Number(s.repMax) || 1)),
        })),
      })),
    };

    const fd = new FormData();
    fd.set("routine", JSON.stringify(payload));
    let result;
    try {
      if (editRoutine) {
        fd.set("routine_id", String(editRoutine.id));
        result = await updateRoutineAction(fd);
      } else {
        result = await createRoutineAction(fd);
      }
    } catch {
      setError("Couldn't save this routine. Please try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(editRoutine ? "Routine updated" : "Routine created");
    onDone?.();
  }

  return (
    <form
      action={submit}
      className="mt-4 space-y-5"
      data-testid="routine-builder"
    >
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}

      <div>
        <label className="label" htmlFor="routine-name">
          Routine name
        </label>
        <input
          id="routine-name"
          data-testid="routine-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
          placeholder="e.g. My Upper/Lower Split"
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="routine-cycle-weeks">
          Cycle length (weeks){" "}
          <span className="font-normal text-slate-400 dark:text-slate-500">
            — optional
          </span>
        </label>
        <input
          id="routine-cycle-weeks"
          data-testid="routine-cycle-weeks"
          type="number"
          min={1}
          max={52}
          value={cycleWeeks}
          onChange={(e) => setCycleWeeks(e.target.value)}
          className="input w-32"
          placeholder="e.g. 5"
        />
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Leave blank for no cycle. The last week is treated as a deload week —
          lighter loads and fewer sets to recover.
        </p>
      </div>

      <div className="space-y-4">
        {days.map((day, di) => (
          <div
            key={di}
            data-testid="builder-day"
            className="rounded-xl border border-black/10 p-3 dark:border-white/10"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label={`Day ${di + 1} label`}
                data-testid="day-label"
                value={day.label}
                onChange={(e) =>
                  patchDay(di, (d) => ({ ...d, label: e.target.value }))
                }
                className="input flex-1 py-1 font-semibold"
                placeholder="Day label (e.g. Push)"
              />
              {days.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${day.label || `day ${di + 1}`}`}
                  onClick={() => setDays((ds) => ds.filter((_, i) => i !== di))}
                  className="shrink-0 text-slate-400 hover:text-rose-500"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Focus regions — auto-derived from the day's exercises, editable. */}
            <div className="mt-2">
              <div className="text-xs text-slate-400 dark:text-slate-500">
                Focus (auto from exercises, tap to adjust)
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {REGION_SCOPES.map((r) => {
                  const active = day.focus.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => toggleFocus(di, r)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                        active
                          ? "border-brand-500 bg-brand-500 text-white"
                          : "border-black/10 bg-white text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-ink-800"
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Slots */}
            <div className="mt-3 space-y-3">
              {day.slots.map((slot, si) => (
                <div
                  key={si}
                  data-testid="builder-slot"
                  className="rounded-lg bg-slate-50 p-2.5 dark:bg-ink-800/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-1 flex-wrap items-center gap-1.5">
                      {slot.candidates.length === 0 ? (
                        <span className="text-xs text-slate-400 dark:text-slate-500">
                          Add one or more exercises (first available is used)
                        </span>
                      ) : (
                        slot.candidates.map((c, ci) => (
                          <span
                            key={ci}
                            data-testid="slot-candidate"
                            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                          >
                            {ci === 0 && (
                              <span className="text-[10px] uppercase opacity-60">
                                1st
                              </span>
                            )}
                            {c}
                            <button
                              type="button"
                              aria-label={`Remove ${c}`}
                              onClick={() =>
                                patchSlot(di, si, (s) => ({
                                  ...s,
                                  candidates: s.candidates.filter(
                                    (_, i) => i !== ci
                                  ),
                                }))
                              }
                              className="text-brand-500 hover:text-rose-500"
                            >
                              <IconX className="h-3 w-3" />
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    {day.slots.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove slot ${si + 1}`}
                        onClick={() =>
                          patchDay(di, (d) => ({
                            ...d,
                            slots: d.slots.filter((_, i) => i !== si),
                          }))
                        }
                        className="shrink-0 text-slate-400 hover:text-rose-500"
                      >
                        <IconTrash className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                    <Combobox
                      value={slot.draft}
                      onChange={(v) =>
                        patchSlot(di, si, (s) => ({ ...s, draft: v }))
                      }
                      onPick={(v) => addCandidate(di, si, v)}
                      options={liftOptions}
                      allowFreeText
                      ariaLabel={`Add exercise to slot ${si + 1}`}
                      placeholder="Search or type a lift…"
                      freeTextLabel={(q) => <>Use “{q}” (custom lift)</>}
                    />
                    <div className="flex items-center gap-1.5">
                      <label className="sr-only" htmlFor={`sets-${di}-${si}`}>
                        Sets
                      </label>
                      <input
                        id={`sets-${di}-${si}`}
                        data-testid="slot-sets"
                        type="number"
                        min={1}
                        value={slot.sets}
                        onChange={(e) =>
                          patchSlot(di, si, (s) => ({
                            ...s,
                            sets: e.target.value,
                          }))
                        }
                        className="input w-14 py-1"
                        aria-label="Sets"
                      />
                      <span className="text-xs text-slate-400">×</span>
                      <input
                        data-testid="slot-rep-min"
                        type="number"
                        min={1}
                        value={slot.repMin}
                        onChange={(e) =>
                          patchSlot(di, si, (s) => ({
                            ...s,
                            repMin: e.target.value,
                          }))
                        }
                        className="input w-14 py-1"
                        aria-label="Minimum reps"
                      />
                      <span className="text-xs text-slate-400">–</span>
                      <input
                        data-testid="slot-rep-max"
                        type="number"
                        min={1}
                        value={slot.repMax}
                        onChange={(e) =>
                          patchSlot(di, si, (s) => ({
                            ...s,
                            repMax: e.target.value,
                          }))
                        }
                        className="input w-14 py-1"
                        aria-label="Maximum reps"
                      />
                      <span className="text-xs text-slate-400">reps</span>
                    </div>
                  </div>
                </div>
              ))}

              <button
                type="button"
                data-testid="add-slot"
                onClick={() =>
                  patchDay(di, (d) => ({
                    ...d,
                    slots: [...d.slots, emptySlot()],
                  }))
                }
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                <IconPlus className="h-4 w-4" /> Add slot
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          data-testid="add-day"
          onClick={() => setDays((ds) => [...ds, emptyDay(ds.length + 1)])}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          <IconPlus className="h-4 w-4" /> Add day
        </button>
        <SubmitButton pendingLabel="Saving…" data-testid="routine-save">
          {editRoutine ? "Save changes" : "Create routine"}
        </SubmitButton>
      </div>
    </form>
  );
}
