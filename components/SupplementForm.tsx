"use client";

import { useMemo, useRef, useState } from "react";
import SupplementCombobox from "@/components/SupplementCombobox";
import Combobox from "@/components/Combobox";
import { useSituationOptions } from "@/components/SituationOptionsContext";
import { useIntakeOptions } from "@/components/IntakeOptionsContext";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import RxNormAffordance from "@/components/intake/RxNormAffordance";
import IntakeInteractionNotices from "@/components/intake/IntakeInteractionNotices";
import DoseRowsEditor, {
  emptyDose,
  type DoseState,
} from "@/components/intake/DoseRowsEditor";
import CadenceEditor, {
  type CadenceState,
} from "@/components/intake/CadenceEditor";
import { parseWeekdays } from "@/lib/intake-cadence";
import KeepApartPairsEditor, {
  type PairState,
} from "@/components/intake/KeepApartPairsEditor";
import CriticalEscalation from "@/components/intake/CriticalEscalation";
import RefillTracking from "@/components/intake/RefillTracking";
import IntakeNotesField from "@/components/intake/IntakeNotesField";
import { useIntakeRxcui } from "@/components/intake/useIntakeRxcui";
import { serializeRxcuiIngredients } from "@/lib/rxnorm";
import {
  applyProductSeed,
  itemSeedFromPool,
  type SupplyOption,
} from "@/lib/supply-product";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import type { IntakeObligation } from "@/lib/types";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import { SUPPLEMENT_BRANDS } from "@/lib/supplement-brands";
import {
  availableConditions,
  CONDITION_LABELS,
  OBLIGATIONS,
  OBLIGATION_HINTS,
  OBLIGATION_LABELS,
  defaultFoodTiming,
  pauseLinkNeedsConfirm,
} from "@/lib/supplement-schedule";
import { useConfirm } from "@/components/ConfirmDialog";
import DraftRestoreBanner from "./DraftRestoreBanner";
import { useFormDraft } from "./useFormDraft";
import type {
  FormResult,
  Supplement,
  SupplementDose,
  SupplementPair,
} from "@/lib/types";

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
  initialSupply = null,
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
  // Opened FROM a shared bottle (#1705) — the cabinet's "Add for another person". The
  // product fields are seeded from it and it links on save.
  initialSupply?: SupplyOption | null;
}) {
  const s = supplement;
  const conditionOptions = availableConditions(
    trainingRestricted,
    s?.condition
  );
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const fid = s?.id ?? "new";

  // Seeded FROM the bottle (#1705): the pool is authoritative for the product, so its
  // name and strength prefill the fields the item form owns the inputs for. Editable —
  // the DOSE is this person's, so the seed is a starting point, never a lock.
  const supplySeed = initialSupply ? itemSeedFromPool(initialSupply) : null;
  const seededRef = useRef(supplySeed);
  const [name, setName] = useState(s?.name ?? supplySeed?.name ?? "");
  const rx = useIntakeRxcui(s);
  const [condition, setCondition] = useState(s?.condition ?? "daily");
  const [situation, setSituation] = useState(s?.situation ?? "");
  const [obligation, setObligation] = useState<IntakeObligation>(
    s?.obligation ?? "should"
  );
  const [pauseSituation, setPauseSituation] = useState(
    s?.pause_situation ?? ""
  );
  const situationOptions = useSituationOptions();
  // The supplement name combobox source. Its ORDER is a per-PROFILE fact (#1677) — this
  // shelf first (retired items included), then a commonality head, then the rest of the
  // catalog — so it arrives through IntakeOptionsContext instead of being the catalog's
  // own category grouping, whose first eight rows were all vitamins.
  const catalogOptions = useIntakeOptions();
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
          weekdays: [...parseWeekdays(d.weekdays)].sort((a, b) => a - b),
          start_date: d.start_date ?? "",
          end_date: d.end_date ?? "",
        }))
      : [{ ...emptyDose(), amount: supplySeed?.amount ?? "" }]
  );

  // A later pick in the form's own bottle selector re-seeds the same two fields, and
  // only them: a value the user has typed is never overwritten (applyProductSeed).
  function onPickSupply(supply: SupplyOption | null): void {
    const seed = supply ? itemSeedFromPool(supply) : null;
    const previous = seededRef.current;
    setName((current) =>
      applyProductSeed(current, previous?.name ?? null, seed?.name ?? "")
    );
    setDoses((ds) =>
      ds.map((d, i) =>
        i === 0
          ? {
              ...d,
              amount: applyProductSeed(
                d.amount,
                previous?.amount ?? null,
                seed?.amount ?? ""
              ),
            }
          : d
      )
    );
    seededRef.current = seed;
  }

  // Item-level calendar (#1602). Seeded from the stored row so an edit round-trips
  // rather than silently resetting a weekly medication to daily.
  const [cadence, setCadence] = useState<CadenceState>(() => ({
    kind: s?.cadence_kind ?? "daily",
    weekdays: [...parseWeekdays(s?.cadence_weekdays)].sort((a, b) => a - b),
    intervalDays:
      s?.cadence_interval_days != null ? String(s.cadence_interval_days) : "",
    anchorDate: s?.cadence_anchor_date ?? "",
  }));

  const others = allSupplements.filter((x) => x.id !== s?.id);
  const [pairRows, setPairRows] = useState<PairState[]>(
    initialPairs.map((p) => ({
      otherId: p.a_id === s?.id ? p.b_id : p.a_id,
      relation: p.relation,
      note: p.note ?? "",
    }))
  );

  // Local draft (#1699). The scalar fields ride in the form's own named inputs;
  // the dose rows, the cadence and the keep-apart pairs are React state that only
  // becomes FormData at submit time, so they go in `extra`.
  const draftExtra = useMemo(
    () => ({
      name,
      condition,
      situation,
      obligation,
      pauseSituation,
      brand,
      doses,
      cadence,
      pairRows,
    }),
    [
      name,
      condition,
      situation,
      obligation,
      pauseSituation,
      brand,
      doses,
      cadence,
      pairRows,
    ]
  );
  type SupplementDraft = typeof draftExtra;
  const draft = useFormDraft<SupplementDraft>({
    formKey: "supplement",
    recordId: s?.id ?? null,
    formRef,
    extra: draftExtra,
    onRestore: (d) => {
      setName(d.name);
      setCondition(d.condition);
      setSituation(d.situation);
      setObligation(d.obligation);
      setPauseSituation(d.pauseSituation);
      setBrand(d.brand);
      setDoses(d.doses);
      setCadence(d.cadence);
      setPairRows(d.pairRows);
    },
    confirmReplace: () =>
      confirm({
        title: "Resume the unsaved supplement?",
        message:
          "This replaces what you have typed here with the entry kept on this device.",
        confirmLabel: "Resume",
      }),
  });

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
    formData.set("cadence_kind", cadence.kind);
    formData.set("cadence_weekdays", cadence.weekdays.join(","));
    formData.set("cadence_interval_days", cadence.intervalDays);
    formData.set("cadence_anchor_date", cadence.anchorDate);
    formData.set("pairs", JSON.stringify(pairRows));
    const label = name.trim() || "Supplement";
    // Consent gate (#1296): a situational hold on a mandatory-priority item silences
    // its reminders while the situation is active — confirm before linking it.
    const pause = pauseSituation.trim();
    if (
      pause &&
      pause !== (s?.pause_situation ?? "") &&
      pauseLinkNeedsConfirm({ kind: "supplement", obligation })
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
    // The record is durably saved — the local draft has no reason to exist, and a
    // surviving one would offer to re-enter what was just written (#1699).
    draft.clear();
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
    }
  }

  const advancedFields = (
    <>
      {/* Obligation (#1505) — the ONE user-owned field deciding reminders, misses
          and escalation. The hint under the selector states the consequences of the
          CURRENT choice, because "May" is otherwise an adjective with no visible
          meaning: the whole failure this model fixes was a level nobody could see
          the effect of. Copy comes from the shared OBLIGATION_HINTS so the form, the
          med confirm dialog and the docs quote one wording. */}
      <div>
        <label className="label" htmlFor={`supp-obligation-${fid}`}>
          Obligation
        </label>
        <select
          id={`supp-obligation-${fid}`}
          name="obligation"
          data-testid="supp-obligation"
          value={obligation}
          onChange={(e) => setObligation(e.target.value as IntakeObligation)}
          className="input"
        >
          {OBLIGATIONS.map((o) => (
            <option key={o} value={o}>
              {OBLIGATION_LABELS[o]}
            </option>
          ))}
        </select>
        <p
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="supp-obligation-hint"
        >
          {OBLIGATION_HINTS[obligation]}
        </p>
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

      <RefillTracking
        fid={fid}
        supplement={s}
        initialSupply={initialSupply}
        onPickSupply={onPickSupply}
      />

      <KeepApartPairsEditor
        pairRows={pairRows}
        setPairRows={setPairRows}
        others={others}
      />

      <IntakeNotesField fid={fid} defaultValue={s?.notes} />
    </>
  );

  return (
    <form ref={formRef} action={handle} className="grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}
      <input type="hidden" name="kind" value="supplement" />

      <DraftRestoreBanner
        draft={draft}
        noun="supplement"
        className="sm:col-span-2"
      />
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
          options={catalogOptions.supplements}
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
      <CadenceEditor value={cadence} onChange={setCadence} />
      <DoseRowsEditor
        doses={doses}
        setDoses={setDoses}
        dosageOptions={entry?.dosages ?? []}
      />

      {s ? (
        advancedFields
      ) : (
        <details
          data-testid="supplement-more-options"
          // Opened FROM a bottle (#1705): the shared-supply control lives inside this
          // disclosure, and a link the user never sees is a link they can't correct.
          open={initialSupply != null}
          className="group sm:col-span-2"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-black/10 bg-white/70 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-white [&::-webkit-details-marker]:hidden dark:border-white/10 dark:bg-ink-850 dark:text-slate-200 dark:hover:bg-ink-750">
            <span>More options</span>
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              Priority, brand, supply, interactions, notes
            </span>
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">{advancedFields}</div>
        </details>
      )}

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
