"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  IconPencil,
  IconTrash,
  IconPlus,
  IconX,
  IconArchive,
  IconArchiveOff,
} from "@tabler/icons-react";
import type { Equipment, EquipmentKind } from "@/lib/types";
import { EQUIPMENT_CATEGORIES, kindOf } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { kgTo, toKg, round, stripNegative } from "@/lib/units";
import { EmptyState } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  createEquipmentAction,
  updateEquipmentAction,
  deleteEquipmentAction,
  setEquipmentRetiredAction,
} from "@/app/(app)/settings/equipment/actions";

interface Draft {
  name: string;
  weight: string; // in display unit, free text
  category: string;
}

// New equipment defaults to Barbell (the common case + only type with a plate
// builder); the user can switch it.
const EMPTY: Draft = { name: "", weight: "", category: "Barbell" };

// The <select> option groups, in kind order. The DB CHECK (migration 018) is the
// source of truth for the value set; kindOf() places each into its group.
const KIND_LABELS: { kind: EquipmentKind; label: string }[] = [
  { kind: "strength", label: "Strength" },
  { kind: "cardio", label: "Cardio" },
  { kind: "recovery", label: "Recovery" },
  { kind: "other", label: "Other" },
];
const CATEGORY_GROUPS = KIND_LABELS.map(({ kind, label }) => ({
  label,
  options: EQUIPMENT_CATEGORIES.filter((c) => kindOf(c) === kind),
})).filter((g) => g.options.length > 0);

function toDraft(e: Equipment, unit: WeightUnit): Draft {
  return {
    name: e.name,
    weight:
      e.weight_kg != null ? String(round(kgTo(e.weight_kg, unit), 2)) : "",
    // The DB converged to the fixed set (migration 018), so category is already a
    // valid option or NULL; fall back to Barbell only for a null.
    category: e.category ?? "Barbell",
  };
}

export default function EquipmentManager({
  equipment,
  unit,
}: {
  equipment: Equipment[];
  unit: WeightUnit;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startAdd() {
    setError(null);
    setEditingId(null);
    setDraft(EMPTY);
    setAdding(true);
  }

  function startEdit(e: Equipment) {
    setError(null);
    setAdding(false);
    setEditingId(e.id);
    setDraft(toDraft(e, unit));
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
    setError(null);
  }

  function payload() {
    const trimmed = draft.weight.trim();
    const num = trimmed === "" ? null : Number(trimmed);
    const weight_kg =
      num != null && Number.isFinite(num) ? toKg(num, unit) : null;
    return {
      name: draft.name,
      weight_kg,
      category: draft.category,
    };
  }

  function save() {
    if (!draft.name.trim()) {
      setError("Give the equipment a name.");
      return;
    }
    const w = draft.weight.trim();
    if (w !== "" && (!Number.isFinite(Number(w)) || Number(w) < 0)) {
      setError("Bar weight must be 0 or more.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res =
        editingId != null
          ? await updateEquipmentAction(editingId, payload())
          : await createEquipmentAction(payload());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const wasEditing = editingId != null;
      cancel();
      toast(wasEditing ? "Equipment updated" : "Equipment added");
      router.refresh();
    });
  }

  async function remove(e: Equipment) {
    const ok = await confirm({
      title: "Delete equipment",
      message: `Delete “${e.name}”? Logged sets keep their weights but lose the implement label.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    startTransition(async () => {
      await deleteEquipmentAction(e.id);
      if (editingId === e.id) cancel();
      toast(`Deleted ${e.name}`);
      router.refresh();
    });
  }

  function toggleRetired(e: Equipment) {
    const next = e.retired ? false : true;
    startTransition(async () => {
      await setEquipmentRetiredAction(e.id, next);
      if (editingId === e.id) cancel();
      toast(next ? `Retired ${e.name}` : `Restored ${e.name}`);
      router.refresh();
    });
  }

  return (
    <div className="card max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Your equipment
        </h2>
        {!adding && editingId == null && (
          <button
            type="button"
            onClick={startAdd}
            className="btn inline-flex items-center gap-1"
          >
            <IconPlus className="h-4 w-4" stroke={2.5} /> Add equipment
          </button>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Name a bar or implement to tag your lifts with it. Logged weights are
        always the <strong>total</strong> load; the bar weight here is for
        reference only and never changes your recorded numbers.
      </p>

      {adding && editingId == null && (
        <EquipmentForm
          draft={draft}
          setDraft={setDraft}
          unit={unit}
          onSave={save}
          onCancel={cancel}
          pending={pending}
          error={error}
        />
      )}

      {equipment.length === 0 && !adding ? (
        <EmptyState message="No equipment defined yet. Add a trap bar, EZ-curl bar, or any custom implement." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {equipment.map((e) =>
            editingId === e.id ? (
              <li key={e.id} className="py-3">
                <EquipmentForm
                  draft={draft}
                  setDraft={setDraft}
                  unit={unit}
                  onSave={save}
                  onCancel={cancel}
                  pending={pending}
                  error={error}
                />
              </li>
            ) : (
              <li
                key={e.id}
                data-testid="equipment-row"
                data-retired={e.retired ? "1" : "0"}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className={`min-w-0 ${e.retired ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {e.name}
                    </span>
                    {e.category && (
                      <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {e.category}
                      </span>
                    )}
                    {e.retired ? (
                      <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        Retired
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {e.weight_kg != null
                      ? `${round(kgTo(e.weight_kg, unit), 2)} ${unit}`
                      : "weight not set"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(e)}
                    disabled={pending}
                    className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    title="Edit"
                  >
                    <IconPencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleRetired(e)}
                    disabled={pending}
                    data-testid="equipment-retire-toggle"
                    className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    title={e.retired ? "Restore" : "Retire"}
                  >
                    {e.retired ? (
                      <IconArchiveOff className="h-4 w-4" />
                    ) : (
                      <IconArchive className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(e)}
                    disabled={pending}
                    className="rounded p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                    title="Delete"
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                </div>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  );
}

function EquipmentForm({
  draft,
  setDraft,
  unit,
  onSave,
  onCancel,
  pending,
  error,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  unit: WeightUnit;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  // The form renders for add AND per-row edit, so label association needs
  // instance-unique ids (getByLabel in the e2e spec, screen readers generally).
  const uid = useId();
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${uid}-name`}>
            Name
          </label>
          <input
            id={`${uid}-name`}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Trap bar"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-weight`}>
            Bar weight ({unit})
          </label>
          <input
            id={`${uid}-weight`}
            value={draft.weight}
            onChange={(e) =>
              setDraft({ ...draft, weight: stripNegative(e.target.value) })
            }
            inputMode="decimal"
            placeholder="optional"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-category`}>
            Type
          </label>
          <select
            id={`${uid}-category`}
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            className="input"
          >
            {CATEGORY_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="text-sm text-rose-500 dark:text-rose-400">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="btn disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="btn-ghost inline-flex items-center gap-1"
        >
          <IconX className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}
