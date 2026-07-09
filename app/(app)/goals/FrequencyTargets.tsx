"use client";

import { useState } from "react";
import type { FrequencyScopeKind } from "@/lib/types";
import { REGION_SCOPES, GROUP_SCOPES, TYPE_SCOPES } from "@/lib/lifts";
import { WeeklyTargets, type WeeklyTarget } from "@/components/WeeklyTargets";
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
  kind: FrequencyScopeKind
): { value: string; label: string }[] {
  return kind === "region"
    ? REGION_SCOPES.map((v) => ({ value: v, label: v }))
    : kind === "group"
      ? GROUP_SCOPES.map((v) => ({ value: v, label: GROUP_LABELS[v] ?? v }))
      : TYPE_SCOPES.map((v) => ({
          value: v,
          label: v[0].toUpperCase() + v.slice(1),
        }));
}

const DEFAULT_KIND: FrequencyScopeKind = "region";
const defaultValue = (kind: FrequencyScopeKind) => optionsFor(kind)[0].value;

// Chips + editor for weekly frequency targets. Clicking a chip loads it into the
// form for editing (and reveals a Delete button); there's one target per scope,
// so saving an existing scope updates its cadence rather than adding a duplicate.
export default function FrequencyTargets({
  items,
}: {
  items: FrequencyTargetItem[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [kind, setKind] = useState<FrequencyScopeKind>(DEFAULT_KIND);
  const [value, setValue] = useState(defaultValue(DEFAULT_KIND));
  const [perWeek, setPerWeek] = useState("2");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSelectedId(null);
    setKind(DEFAULT_KIND);
    setValue(defaultValue(DEFAULT_KIND));
    setPerWeek("2");
  }

  function selectTarget(t: WeeklyTarget) {
    if (t.id === selectedId) return reset(); // click the selected chip to deselect
    const item = items.find((it) => it.id === t.id);
    if (!item) return;
    setSelectedId(item.id);
    setKind(item.scopeKind);
    setValue(item.scopeValue);
    setPerWeek(String(item.perWeek));
  }

  function changeKind(k: FrequencyScopeKind) {
    setKind(k);
    setValue(defaultValue(k));
  }

  async function save(fd: FormData) {
    setError(null);
    const updating = selectedId != null;
    try {
      await createFrequencyTarget(fd);
    } catch {
      // Keep the form and its selections intact; surface the failure inline.
      setError("Couldn't save this routine. Please try again.");
      return;
    }
    toast(updating ? "Routine updated" : "Routine added");
    reset();
  }

  async function remove() {
    if (selectedId == null) return;
    const ok = await confirm({
      title: "Delete routine",
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
      setError("Couldn't delete this routine. Please try again.");
      return;
    }
    toast("Routine deleted");
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
      <form action={save} className="mt-3 flex flex-wrap items-end gap-3">
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
            onChange={(e) => changeKind(e.target.value as FrequencyScopeKind)}
            className="input"
          >
            <option value="region">Muscle region</option>
            <option value="group">Body group</option>
            <option value="type">Activity type</option>
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
            {optionsFor(kind).map((v) => (
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
        <SubmitButton pendingLabel="Saving…">
          {selectedId == null ? "Add routine" : "Update routine"}
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
