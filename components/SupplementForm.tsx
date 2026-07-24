"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SupplementCombobox from "@/components/SupplementCombobox";
import Combobox from "@/components/Combobox";
import { useSituationOptions } from "@/components/SituationOptionsContext";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import RxNormAffordance from "@/components/intake/RxNormAffordance";
import IntakeInteractionNotices from "@/components/intake/IntakeInteractionNotices";
import DoseRowsEditor, {
  emptyDose,
  type DoseState,
} from "@/components/intake/DoseRowsEditor";
import KeepApartPairsEditor, {
  type PairState,
} from "@/components/intake/KeepApartPairsEditor";
import CriticalEscalation from "@/components/intake/CriticalEscalation";
import RefillTracking from "@/components/intake/RefillTracking";
import IntakeNotesField from "@/components/intake/IntakeNotesField";
import { useIntakeRxcui } from "@/components/intake/useIntakeRxcui";
import { serializeRxcuiIngredients } from "@/lib/rxnorm";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import { SUPPLEMENT_BRANDS } from "@/lib/supplement-brands";
import {
  availableConditions,
  CONDITION_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  defaultFoodTiming,
  pauseLinkNeedsConfirm,
} from "@/lib/supplement-schedule";
import { useConfirm } from "@/components/ConfirmDialog";
import type {
  FormResult,
  Supplement,
  SupplementDose,
  SupplementPair,
} from "@/lib/types";

const CATALOG_NAMES = SUPPLEMENT_CATALOG.map((c) => c.name);
const CATALOG_BY_NAME = new Map(
  SUPPLEMENT_CATALOG.map((c) => [c.name.toLowerCase(), c])
);

// The supplement add/edit form (#846, real split from the former shared
// IntakeItemForm). Owns the supplement-shaped surface — catalog/brand suggestions,
// priority, stack, and workout/rest/situational condition scheduling — and composes
// the genuinely-shared subcomponents (RxNorm confirm, cross-kind interaction notices,
// dose rows, keep-apart pairs, critical escalation, refill, notes). It renders NONE
// of the medication concepts (no prescriber/Rx, no PRN, no med catalog); the
// Medications page uses MedicationForm. With no `supplement` it's an add form; with
// one it edits in place and calls `onDone` after a successful save.
export default function SupplementForm({
  action,
  supplement,
  doses: initialDoses,
  allSupplements = [],
  stackItems = [],
  pgxVariants = [],
  pairs: initialPairs = [],
  onDone,
  trainingRestricted = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  supplement?: Supplement;
  doses?: SupplementDose[];
  allSupplements?: { id: number; name: string }[];
  stackItems?: InteractionItem[];
  pgxVariants?: PgxVariantInput[];
  pairs?: SupplementPair[];
  onDone?: () => void;
  trainingRestricted?: boolean;
}) {
  const s = supplement;
  const conditionOptions = availableConditions(
    trainingRestricted,
    s?.condition
  );
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const fid = s?.id ?? "new";

  const [name, setName] = useState(s?.name ?? "");
  const rx = useIntakeRxcui(s);
  const [condition, setCondition] = useState(s?.condition ?? "daily");
  const [situation, setSituation] = useState(s?.situation ?? "");
  const [pauseSituation, setPauseSituation] = useState(
    s?.pause_situation ?? ""
  );
  const situationOptions = useSituationOptions();
  const confirm = useConfirm();
  const [brand, setBrand] = useState(s?.brand ?? "");
  const [critical, setCritical] = useState(s?.critical === 1);
  const [error, setError] = useState<string | null>(null);
  const [doses, setDoses] = useState<DoseState[]>(
    initialDoses && initialDoses.length
      ? initialDoses.map((d) => ({
          id: d.id,
          amount: d.amount ?? "",
          time_of_day: d.time_of_day ?? "",
          food_timing: d.food_timing,
        }))
      : [emptyDose()]
  );

  const others = allSupplements.filter((x) => x.id !== s?.id);
  const [pairRows, setPairRows] = useState<PairState[]>(
    initialPairs.map((p) => ({
      otherId: p.a_id === s?.id ? p.b_id : p.a_id,
      relation: p.relation,
      note: p.note ?? "",
    }))
  );

  const entry = CATALOG_BY_NAME.get(name.trim().toLowerCase());

  // Picking a catalogued supplement seeds the first dose (amount/time/food) from the
  // catalog — supplement-only behavior, unchanged from the pre-split form.
  function onPickName(picked: string) {
    const e = CATALOG_BY_NAME.get(picked.toLowerCase());
    const food = defaultFoodTiming(picked, e?.defaultFoodTiming);
    setDoses((ds) =>
      ds.map((d, i) =>
        i === 0
          ? {
              ...d,
              amount: d.amount || e?.dosages[0] || "",
              time_of_day: e?.defaultTimeOfDay ?? d.time_of_day,
              food_timing: d.food_timing === "any" ? food : d.food_timing,
            }
          : d
      )
    );
  }

  async function handle(formData: FormData) {
    setError(null);
    formData.set("doses", JSON.stringify(doses));
    formData.set("pairs", JSON.stringify(pairRows));
    const label = name.trim() || "Supplement";
    // Consent gate (#1296): a situational hold on a mandatory-priority item silences
    // its reminders while the situation is active — confirm before linking it.
    const pause = pauseSituation.trim();
    const priority = String(formData.get("priority") ?? "high");
    if (
      pause &&
      pause !== (s?.pause_situation ?? "") &&
      pauseLinkNeedsConfirm({
        kind: "supplement",
        priority: priority as Supplement["priority"],
      })
    ) {
      const ok = await confirm({
        title: "Pause reminders?",
        message: `This will silence reminders for ${label} while ${pause} is active. Link the pause?`,
        confirmLabel: "Link pause",
      });
      if (!ok) return;
    }
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      setError("Couldn't save this supplement. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(s ? `${label} updated` : `${label} added`);
    if (onDone) onDone();
    else {
      formRef.current?.reset();
      setName("");
      rx.reset();
      setCondition("daily");
      setSituation("");
      setPauseSituation("");
      setBrand("");
      // The critical checkbox sits outside the reset form, so clear it by hand (#627).
      setCritical(false);
      setDoses([emptyDose()]);
      setPairRows([]);
      router.refresh();
    }
  }

  return (
    <form ref={formRef} action={handle} className="grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}
      <input type="hidden" name="kind" value="supplement" />
      <input type="hidden" name="rxcui" value={rx.rxcui ?? ""} />
      <input
        type="hidden"
        name="rxcui_ingredients"
        value={serializeRxcuiIngredients(rx.rxcuiIngredients ?? []) ?? ""}
      />

      <div>
        <label className="label">Name</label>
        <SupplementCombobox
          name="name"
          ariaLabel="Name"
          value={name}
          onChange={(v) => {
            setName(v);
            rx.onNameChange();
          }}
          onPick={onPickName}
          options={CATALOG_NAMES}
          placeholder="e.g. Vitamin D3"
        />
        <RxNormAffordance name={name} rx={rx} />
      </div>

      <IntakeInteractionNotices
        name={name}
        rxcui={rx.rxcui}
        rxcuiIngredients={rx.rxcuiIngredients}
        stackItems={stackItems}
        pgxVariants={pgxVariants}
        excludeId={s?.id}
      />

      <div>
        <label className="label" htmlFor={`supp-when-${fid}`}>
          When
        </label>
        <select
          id={`supp-when-${fid}`}
          name="condition"
          value={condition}
          onChange={(e) =>
            setCondition(e.target.value as Supplement["condition"])
          }
          className="input"
        >
          {conditionOptions.map((c) => (
            <option key={c} value={c}>
              {CONDITION_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`supp-priority-${fid}`}>
          Priority
        </label>
        <select
          id={`supp-priority-${fid}`}
          name="priority"
          defaultValue={s?.priority ?? "high"}
          className="input"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`supp-stack-${fid}`}>
          Stack (optional)
        </label>
        <input
          id={`supp-stack-${fid}`}
          name="stack"
          defaultValue={s?.stack ?? ""}
          className="input"
          placeholder="e.g. D3 + K2"
        />
      </div>

      {condition === "situational" && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`supp-situation-${fid}`}>
            Situation
          </label>
          <Combobox
            id={`supp-situation-${fid}`}
            name="situation"
            ariaLabel="Situation"
            value={situation}
            onChange={setSituation}
            options={situationOptions}
            allowFreeText
            placeholder="e.g. Illness"
          />
          {/* Discovery hint for the DERIVED situations (#1292/#1298): keying to Poor
              sleep / Period goes live automatically — no manual toggle — from the
              profile's own sleep / cycle data. */}
          {/poor\s*sleep|period/i.test(situation.trim()) && (
            <p
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              data-testid="derived-situation-hint"
            >
              {/period/i.test(situation.trim())
                ? "Goes live automatically on logged period days."
                : "Goes live automatically on rough nights — no toggle needed."}
            </p>
          )}
        </div>
      )}

      {/* Pause during… — the INVERSE situational link (#1296): hold this item while
        the chosen situation is active (Pre-surgery stops fish oil / vitamin E).
        Independent of the "When" condition; always available. */}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`supp-pause-${fid}`}>
          Pause during (optional)
        </label>
        <Combobox
          id={`supp-pause-${fid}`}
          name="pause_situation"
          ariaLabel="Pause during situation"
          value={pauseSituation}
          onChange={setPauseSituation}
          options={situationOptions}
          allowFreeText
          placeholder="e.g. Pre-surgery"
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Held (not due) while this situation is active — you can still log it.
        </p>
      </div>

      <div>
        <label className="label">Brand</label>
        <SupplementCombobox
          name="brand"
          ariaLabel="Brand"
          value={brand}
          onChange={setBrand}
          options={SUPPLEMENT_BRANDS}
          placeholder="e.g. Thorne"
        />
      </div>

      <div>
        <label className="label" htmlFor={`supp-product-${fid}`}>
          Product
        </label>
        <input
          id={`supp-product-${fid}`}
          name="product"
          defaultValue={s?.product ?? ""}
          className="input"
          placeholder="e.g. Vitamin D/K2"
        />
      </div>

      <CriticalEscalation
        fid={fid}
        supplement={s}
        critical={critical}
        setCritical={setCritical}
      />

      <RefillTracking fid={fid} supplement={s} />

      <DoseRowsEditor
        doses={doses}
        setDoses={setDoses}
        dosageOptions={entry?.dosages ?? []}
      />

      <KeepApartPairsEditor
        pairRows={pairRows}
        setPairRows={setPairRows}
        others={others}
      />

      <IntakeNotesField fid={fid} defaultValue={s?.notes} />

      {error && (
        <p
          role="alert"
          className="text-sm text-rose-600 sm:col-span-2 dark:text-rose-400"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 sm:col-span-2">
        <SubmitButton pendingLabel="Saving…">{s ? "Save" : "Add"}</SubmitButton>
        {onDone && (
          <button type="button" onClick={onDone} className="btn-ghost">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
