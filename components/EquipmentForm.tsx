"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { EQUIPMENT_CATEGORIES, kindOf, type Equipment } from "@/lib/types";
import type { WeightUnit } from "@/lib/settings";
import { kgTo, round, stripNegative, toKg } from "@/lib/units";
import {
  createEquipmentAction,
  updateEquipmentAction,
} from "@/app/(app)/equipment/actions";
import FactChipRow, { FactChip, FactMoreChip } from "./facts/FactChipRow";
import FactEditorHost, { useFactEditor } from "./facts/FactEditorHost";
import Button from "./Button";
import { useToast } from "./Toast";
import type { CatalogFormCallbacks } from "./CatalogEditor";

export interface EquipmentFormProps {
  equipment?: Equipment;
  unit: WeightUnit;
  strengthTrainingAvailable?: boolean;
  strengthOnly?: boolean;
  defaultCategory?: string;
}

export default function EquipmentForm({
  equipment,
  unit,
  strengthTrainingAvailable = true,
  strengthOnly = false,
  defaultCategory,
  onSaved,
  onCancel,
  onPendingChange,
}: EquipmentFormProps & CatalogFormCallbacks<Equipment>) {
  const [name, setName] = useState(equipment?.name ?? "");
  const initialCategory =
    equipment?.category ??
    defaultCategory ??
    (strengthTrainingAvailable ? "Barbell" : "Bike");
  const initialWeight =
    equipment?.weight_kg == null
      ? ""
      : String(round(kgTo(equipment.weight_kg, unit), 2));
  const [category, setCategory] = useState(initialCategory);
  const [weight, setWeight] = useState(initialWeight);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scopeRef = useRef<HTMLDivElement>(null);
  const editor = useFactEditor<"name" | "category" | "weight">({
    scopeRef,
    initial: equipment ? null : "name",
  });
  const uid = useId();
  const toast = useToast();
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  const categories = EQUIPMENT_CATEGORIES.filter((c) =>
    strengthOnly
      ? kindOf(c) === "strength"
      : strengthTrainingAvailable || kindOf(c) !== "strength"
  );
  const dirty =
    name !== (equipment?.name ?? "") ||
    category !== initialCategory ||
    weight !== initialWeight;

  function save() {
    if (!name.trim()) {
      setError("Give the equipment a name.");
      editor.open("name");
      return;
    }
    if (!category) {
      setError("Pick a category.");
      editor.open("category");
      return;
    }
    if (
      weight.trim() &&
      (!Number.isFinite(Number(weight)) || Number(weight) < 0)
    ) {
      setError("Equipment weight must be 0 or more.");
      editor.open("weight");
      return;
    }
    setError(null);
    startTransition(async () => {
      const input = {
        name: name.trim(),
        category,
        weight_kg: weight.trim() === "" ? null : toKg(Number(weight), unit),
      };
      try {
        if (equipment) {
          const result = await updateEquipmentAction(equipment.id, input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("Equipment updated");
          onSaved({ ...equipment, ...input });
        } else {
          const result = await createEquipmentAction(input);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          toast("Equipment added");
          onSaved(result.equipment);
        }
      } catch {
        setError("Couldn’t save equipment. Try again.");
      }
    });
  }

  return (
    <div
      ref={scopeRef}
      data-unsaved={dirty ? "true" : "false"}
      onKeyDown={editor.onKeyDown}
      className="space-y-3"
    >
      {!editor.openEditor && (
        <FactChipRow>
          <FactChip
            label={<span className="wrap-anywhere">{name || "Add name"}</span>}
            state={name ? "stated" : "missing"}
            focusKey="name"
            expanded={false}
            onOpen={() => editor.open("name")}
          />
          <FactChip
            label={category || "Choose type"}
            state={category ? "stated" : "missing"}
            focusKey="category"
            expanded={false}
            onOpen={() => editor.open("category")}
          />
          {weight ? (
            <FactChip
              label={`${weight} ${unit}`}
              focusKey="weight"
              expanded={false}
              onOpen={() => editor.open("weight")}
            />
          ) : (
            <FactMoreChip
              label="Equipment weight"
              focusKey="weight"
              expanded={false}
              onOpen={() => editor.open("weight")}
            />
          )}
        </FactChipRow>
      )}
      {editor.openEditor && (
        <FactEditorHost panel={editor.openEditor} onDone={editor.close}>
          <label className="label" htmlFor={uid}>
            {editor.openEditor === "name"
              ? "Name"
              : editor.openEditor === "category"
                ? "Type"
                : `Equipment weight (${unit})`}
          </label>
          {editor.openEditor === "name" ? (
            <input
              id={uid}
              autoFocus
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : editor.openEditor === "category" ? (
            <select
              id={uid}
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Choose type</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={uid}
              className="input"
              inputMode="decimal"
              placeholder="Optional"
              value={weight}
              onChange={(e) => setWeight(stripNegative(e.target.value))}
            />
          )}
        </FactEditorHost>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" onClick={save} disabled={pending}>
          {pending ? "Saving…" : strengthOnly ? "Add" : "Save"}
        </Button>
        <Button onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
