"use client";

import { useState } from "react";
import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import type { FrequencyScopeKind } from "@/lib/frequency-targets";
import { REGION_SCOPES, GROUP_SCOPES, TYPE_SCOPES } from "@/lib/lifts";
import { WeeklyTargets, type WeeklyTarget } from "@/components/WeeklyTargets";
import Collapse from "@/components/Collapse";
import SubmitButton from "@/components/SubmitButton";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  createFrequencyTarget,
  deleteFrequencyTarget,
} from "./frequency-actions";

const GROUP_LABELS: Record<string, string> = {
  Upper: "Upper body",
  Lower: "Lower body",
  Core: "Core",
  Full: "Full body",
};

// A weekly target's display fields (WeeklyTarget) plus what the editor needs to
// load it back into the form.
export interface FrequencyTargetItem extends WeeklyTarget {
  id: number;
  scopeKind: FrequencyScopeKind;
  scopeValue: string;
}

function optionsFor(
  kind: FrequencyScopeKind,
  strengthTrainingAvailable = true
): { value: string; label: string }[] {
  // Mobility-region (#840) reuses the MuscleRegion vocabulary — a separate weekly view
  // counted from mobility sessions, kept apart from strength `region` (#482).
  if (kind === "region" || kind === "mobility_region")
    return REGION_SCOPES.map((v) => ({ value: v, label: v }));
  if (kind === "group")
    return GROUP_SCOPES.map((v) => ({ value: v, label: GROUP_LABELS[v] ?? v }));
  return TYPE_SCOPES.filter(
    (v) => strengthTrainingAvailable || v !== "strength"
  ).map((v) => ({
    value: v,
    label: v[0].toUpperCase() + v.slice(1),
  }));
}

const FORM_PANEL_ID = "frequency-target-form";

const DEFAULT_KIND: FrequencyScopeKind = "region";
const defaultValue = (kind: FrequencyScopeKind, strength = true) =>
  optionsFor(kind, strength)[0].value;

// Chips + editor for weekly frequency targets. Clicking a chip loads it into the
// form for editing (and reveals a Delete button); there's one target per scope,
// so saving an existing scope updates its cadence rather than adding a duplicate.
//
// THE ENTRY FORM FOLDS (#3474 item 2, the #1497 rare-cadence rule). Setting a weekly
// frequency target is a few-times-ever act, and this card is the first thing the Plan
// tab shows on a phone — two selects, a number field and a primary submit standing open
// on every visit is exactly the class #1497 banned. The CHIPS stay standing; only the
// form folds.
//
// Deliberately NOT <AddEntryPanel>, for two reasons, and both are structural:
//   1. That primitive draws a `.card` around itself when open, and this form lives
//      INSIDE the Weekly targets card — a card in a card, which the container grammar
//      forbids (docs/internals/design-system.md §2).
//   2. Its `open` is uncontrolled by design ("the INITIAL state only, never a
//      controlled value"), and selecting a target chip must OPEN this form with that
//      target loaded — the editing affordance #3474 preserves word for word.
// So this is a route-local disclosure over the same shared <Collapse>, which keeps the
// folded controls out of the tab order and the accessibility tree while hidden — the
// same shape and the same reason as TtcOffDisclosure (#2583).
export default function FrequencyTargets({
  items,
  strengthTrainingAvailable = true,
}: {
  items: FrequencyTargetItem[];
  strengthTrainingAvailable?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const initialKind: FrequencyScopeKind = strengthTrainingAvailable
    ? DEFAULT_KIND
    : "type";
  const [kind, setKind] = useState<FrequencyScopeKind>(initialKind);
  const [value, setValue] = useState(
    defaultValue(initialKind, strengthTrainingAvailable)
  );
  const [perWeek, setPerWeek] = useState("2");
  const [error, setError] = useState<string | null>(null);
  // The fold (#3474 item 2). Closed on arrival; opened by the "Add target" toggle or
  // by selecting a chip to edit, and closed again by a save, a delete or a deselect —
  // every path that leaves the form with nothing left to say.
  const [formOpen, setFormOpen] = useState(false);

  function reset() {
    setSelectedId(null);
    setKind(initialKind);
    setValue(defaultValue(initialKind, strengthTrainingAvailable));
    setPerWeek("2");
    setFormOpen(false);
  }

  function selectTarget(t: WeeklyTarget) {
    if (t.id === selectedId) return reset(); // click the selected chip to deselect
    const item = items.find((it) => it.id === t.id);
    if (!item) return;
    setSelectedId(item.id);
    setKind(item.scopeKind);
    setValue(item.scopeValue);
    setPerWeek(String(item.perWeek));
    setFormOpen(true);
  }

  function changeKind(k: FrequencyScopeKind) {
    setKind(k);
    setValue(defaultValue(k, strengthTrainingAvailable));
  }

  async function save(fd: FormData) {
    setError(null);
    const updating = selectedId != null;
    try {
      await createFrequencyTarget(fd);
    } catch {
      // Keep the form and its selections intact; surface the failure inline.
      setError("Couldn't save this target. Try again.");
      return;
    }
    toast(updating ? "Target updated" : "Target added");
    reset();
  }

  async function remove() {
    if (selectedId == null) return;
    const ok = await confirm({
      title: "Delete target",
      message: "Delete this weekly frequency target? This can’t be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    const fd = new FormData();
    fd.set("id", String(selectedId));
    try {
      await deleteFrequencyTarget(fd);
    } catch {
      setError("Couldn't delete this target. Try again.");
      return;
    }
    toast("Target deleted");
    reset();
  }

  return (
    <div>
      {items.length > 0 && (
        <div className="mt-3">
          <WeeklyTargets
            targets={items}
            onSelect={selectTarget}
            selectedId={selectedId}
          />
        </div>
      )}
      <button
        type="button"
        data-testid="frequency-target-toggle"
        aria-expanded={formOpen}
        aria-controls={FORM_PANEL_ID}
        onClick={() => (formOpen ? reset() : setFormOpen(true))}
        className={
          formOpen
            ? "mt-3 flex min-h-11 w-full items-center justify-between gap-2 text-left text-sm font-semibold text-slate-800 dark:text-slate-100"
            : "btn-ghost mt-3 text-sm"
        }
      >
        {formOpen ? (
          <>
            <span>{selectedId == null ? "Add target" : "Update target"}</span>
            <IconChevronDown
              className="h-4 w-4 shrink-0 rotate-180 transition-transform"
              aria-hidden="true"
            />
          </>
        ) : (
          <>
            <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
            Add target
          </>
        )}
      </button>
      <Collapse open={formOpen}>
        <div id={FORM_PANEL_ID} className="pt-3">
          <form action={save} className="flex flex-wrap items-end gap-3">
            {/* When editing, carry the row id so the action updates it in place —
            including a scope change — instead of inserting a duplicate. */}
            {selectedId != null && (
              <input type="hidden" name="id" value={selectedId} />
            )}
            <div>
              <label className="label">Scope</label>
              <select
                name="scope_kind"
                value={kind}
                onChange={(e) =>
                  changeKind(e.target.value as FrequencyScopeKind)
                }
                className="input"
              >
                {strengthTrainingAvailable && (
                  <option value="region">Muscle region</option>
                )}
                {strengthTrainingAvailable && (
                  <option value="group">Body group</option>
                )}
                <option value="type">Activity type</option>
                <option value="mobility_region">Mobility region</option>
              </select>
            </div>
            <div>
              <label className="label">Target</label>
              <select
                name="scope_value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="input"
              >
                {optionsFor(kind, strengthTrainingAvailable).map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Per week</label>
              <input
                type="number"
                name="per_week"
                min={1}
                value={perWeek}
                onChange={(e) => setPerWeek(e.target.value)}
                className="input w-24"
              />
            </div>
            {/* Plain form grammar ("Save"), not a second "Add target" (#3474 item 2).
            The DISCLOSURE above is the card's create affordance and carries that
            name; two controls answering to it inside one card is a duplicate
            accessible name, and the one the user reaches first would be the wrong
            one. Same split CycleForm already ships under its own fold. */}
            <SubmitButton pendingLabel="Saving…" variant="primary">
              Save
            </SubmitButton>
            {selectedId != null && (
              <button
                type="button"
                onClick={remove}
                className="btn-ghost text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
              >
                Delete
              </button>
            )}
          </form>
        </div>
      </Collapse>
      {error && (
        <p
          role="alert"
          className="mt-2 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
