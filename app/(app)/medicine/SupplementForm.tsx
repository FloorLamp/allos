"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconX, IconAlertTriangle } from "@tabler/icons-react";
import SupplementCombobox from "./SupplementCombobox";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { lookupRxcui, lookupRxcuiIngredients } from "./actions";
import { parseRxcuiIngredients, serializeRxcuiIngredients } from "@/lib/rxnorm";
import {
  interactionsForCandidate,
  interactionTitle,
  SEVERITY_LABEL,
  type InteractionItem,
} from "@/lib/drug-interactions";
import {
  matchFoodInteractions,
  foodGuidanceLine,
  foodGuidanceDetail,
} from "@/lib/food-drug-interactions";
import { SUPPLEMENT_CATALOG } from "@/lib/supplement-catalog";
import { SUPPLEMENT_BRANDS } from "@/lib/supplement-brands";
import {
  availableConditions,
  CONDITION_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  SUGGESTED_SITUATIONS,
  TIME_BUCKETS,
  FOOD_TIMINGS,
  FOOD_TIMING_LABELS,
  defaultFoodTiming,
} from "@/lib/supplement-schedule";
import type {
  FoodTiming,
  FormResult,
  PairRelation,
  Supplement,
  SupplementDose,
  SupplementKind,
  SupplementPair,
} from "@/lib/types";

const CATALOG_NAMES = SUPPLEMENT_CATALOG.map((c) => c.name);
const CATALOG_BY_NAME = new Map(
  SUPPLEMENT_CATALOG.map((c) => [c.name.toLowerCase(), c])
);

interface DoseState {
  id?: number;
  amount: string;
  time_of_day: string;
  food_timing: FoodTiming;
}

const emptyDose = (): DoseState => ({
  amount: "",
  time_of_day: "",
  food_timing: "any",
});

interface PairState {
  otherId: number;
  relation: PairRelation;
  note: string;
}

// Shared add/edit form. With no `supplement` it's an add form; with one it edits
// in place (its doses passed in) and calls `onDone` after a successful save.
export default function SupplementForm({
  action,
  supplement,
  doses: initialDoses,
  allSupplements = [],
  stackItems = [],
  pairs: initialPairs = [],
  onDone,
  trainingRestricted = false,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  supplement?: Supplement;
  doses?: SupplementDose[];
  allSupplements?: { id: number; name: string }[];
  // The profile's other items (name + cached RxCUI + active) for the create/edit
  // interaction check (issue #144). The pure detector runs client-side over the
  // bundled dataset, so the inline notice is a formatter over the SAME computation
  // the /medicine warnings + Upcoming finding use.
  stackItems?: InteractionItem[];
  pairs?: SupplementPair[];
  onDone?: () => void;
  trainingRestricted?: boolean;
}) {
  const s = supplement;
  // Hide the workout/rest-day schedule options when fitness tracking is
  // restricted for this profile, but keep whatever this item already stores so
  // the select value stays valid while editing (see lib/supplement-schedule.ts).
  const conditionOptions = availableConditions(
    trainingRestricted,
    s?.condition
  );
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);

  const [name, setName] = useState(s?.name ?? "");
  // Cached RxNorm concept id (issue #144) — confirmed from the lookup affordance,
  // saved into the hidden `rxcui` field. Null → the interaction matcher uses name.
  const [rxcui, setRxcui] = useState<string | null>(s?.rxcui ?? null);
  // The confirmed concept's ACTIVE-INGREDIENT RxCUIs (issue #279), resolved from
  // RxNav when a candidate is confirmed and saved into the hidden
  // `rxcui_ingredients` field. A combination product's product-level rxcui never
  // appears in the ingredient-keyed datasets, so the matchers also try each of
  // these. Null → product-rxcui + name matching only (graceful degradation).
  const [rxcuiIngredients, setRxcuiIngredients] = useState<string[] | null>(
    () => {
      const stored = parseRxcuiIngredients(s?.rxcui_ingredients ?? null);
      return stored.length > 0 ? stored : null;
    }
  );
  const [rxCandidates, setRxCandidates] = useState<
    { rxcui: string; name: string; score: number }[] | null
  >(null);
  const [rxLoading, setRxLoading] = useState(false);
  const [rxError, setRxError] = useState<string | null>(null);

  // Latest confirmed code — guards the async ingredient resolve against a stale
  // response landing after the user cleared or re-confirmed a different code.
  const rxcuiRef = useRef<string | null>(s?.rxcui ?? null);
  function applyRxcui(code: string | null, ingredients: string[] | null) {
    rxcuiRef.current = code;
    setRxcui(code);
    setRxcuiIngredients(ingredients);
  }
  // Confirm a candidate: set the code immediately, then resolve its active-
  // ingredient CUIs (issue #279) in the background so a combination product
  // matches each ingredient's interaction concept. Degrades silently — on
  // timeout/error the item keeps product-rxcui + name matching.
  async function confirmRxcui(code: string) {
    applyRxcui(code, null);
    setRxCandidates(null);
    setRxError(null);
    try {
      const ingredients = await lookupRxcuiIngredients(code);
      if (rxcuiRef.current === code && ingredients.length > 0) {
        setRxcuiIngredients(ingredients);
      }
    } catch {
      // Keep product-rxcui + name matching.
    }
  }

  async function findRxcui() {
    const term = name.trim();
    if (!term) return;
    setRxLoading(true);
    setRxError(null);
    try {
      const candidates = await lookupRxcui(term);
      setRxCandidates(candidates);
      if (candidates.length === 0) {
        setRxError(
          "No RxNorm match found (the lookup may be offline). You can still save — interactions will match by name."
        );
      }
    } catch {
      setRxError("Couldn't reach the RxNorm lookup. You can still save.");
      setRxCandidates([]);
    } finally {
      setRxLoading(false);
    }
  }

  // Interactions of the item being entered/edited against the rest of the ACTIVE
  // stack (excluding this row itself). One pure computation, client-side over the
  // bundled dataset — the inline notice can never disagree with the /medicine
  // section or the Upcoming finding.
  const candidateInteractions = useMemo(() => {
    if (!name.trim()) return [];
    const others = stackItems.filter((x) => x.id !== s?.id);
    return interactionsForCandidate({ name, rxcui, rxcuiIngredients }, others);
  }, [name, rxcui, rxcuiIngredients, stackItems, s?.id]);

  // Food–drug guidance for the item being entered/edited (issue #154) — needs no
  // second item, just this one's name + confirmed RxCUI(s). Same pure matcher the
  // /medicine row line and the dose-reminder copy format over.
  const candidateFoodInteractions = useMemo(() => {
    if (!name.trim()) return [];
    return matchFoodInteractions({ name, rxcui, rxcuiIngredients });
  }, [name, rxcui, rxcuiIngredients]);

  const [condition, setCondition] = useState(s?.condition ?? "daily");
  const [brand, setBrand] = useState(s?.brand ?? "");
  // Medication identity — a medication reveals prescriber/pharmacy/
  // Rx + an "as needed" (PRN) toggle that suppresses scheduled reminders.
  const [kind, setKind] = useState<SupplementKind>(s?.kind ?? "supplement");
  const [asNeeded, setAsNeeded] = useState(s?.as_needed === 1);
  // Missed-dose escalation — critical meds get a follow-up nudge.
  const [critical, setCritical] = useState(s?.critical === 1);
  const [error, setError] = useState<string | null>(null);
  // Unique id suffix so multiple forms on one page (add + inline edit rows)
  // don't collide on label/input ids.
  const fid = s?.id ?? "new";
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

  // Other supplements this one can be paired with.
  const others = allSupplements.filter((x) => x.id !== s?.id);
  const [pairRows, setPairRows] = useState<PairState[]>(
    initialPairs.map((p) => ({
      otherId: p.a_id === s?.id ? p.b_id : p.a_id,
      relation: p.relation,
      note: p.note ?? "",
    }))
  );

  const entry = CATALOG_BY_NAME.get(name.trim().toLowerCase());

  function setPair(i: number, patch: Partial<PairState>) {
    setPairRows((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function setDose(i: number, patch: Partial<DoseState>) {
    setDoses((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

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
    let result: FormResult;
    try {
      result = await action(formData);
    } catch {
      // Keep the form (and everything typed) mounted; surface the failure.
      setError("Couldn't save this supplement. Please try again.");
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
      // applyRxcui resets the code, its resolved active-ingredient CUIs, AND the
      // rxcuiRef guard together — resetting `rxcui` alone (issue #627) leaked the
      // prior item's `rxcui_ingredients` onto the next add (the name-change handler
      // only clears ingredients when a code is set, and after reset there is none).
      applyRxcui(null, null);
      setRxCandidates(null);
      setRxError(null);
      setCondition("daily");
      setBrand("");
      setKind("supplement");
      setAsNeeded(false);
      // The critical checkbox sits outside the medication-only block, so a stale
      // `checked` state silently saved the next item critical (issue #627).
      setCritical(false);
      setDoses([emptyDose()]);
      setPairRows([]);
      router.refresh();
    }
  }

  return (
    <form ref={formRef} action={handle} className="grid gap-4 sm:grid-cols-2">
      {s && <input type="hidden" name="id" value={s.id} />}
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="rxcui" value={rxcui ?? ""} />
      <input
        type="hidden"
        name="rxcui_ingredients"
        value={serializeRxcuiIngredients(rxcuiIngredients ?? []) ?? ""}
      />

      {/* Kind toggle — Supplement vs Medication */}
      <div className="sm:col-span-2">
        <label className="label">Type</label>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          {(["supplement", "medication"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`px-3 py-1.5 text-sm font-medium capitalize ${
                kind === k
                  ? "bg-brand-600 text-white"
                  : "bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-800"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">Name</label>
        <SupplementCombobox
          name="name"
          ariaLabel="Name"
          value={name}
          onChange={(v) => {
            setName(v);
            // A name edit invalidates a previously-confirmed code (and its
            // resolved ingredients).
            if (rxcui) applyRxcui(null, null);
            setRxCandidates(null);
            setRxError(null);
          }}
          onPick={onPickName}
          options={CATALOG_NAMES}
          placeholder="e.g. Vitamin D3"
        />
        {/* RxNorm normalization (issue #144): confirm an RxCUI so interactions match
            on a stable code, not just the name. The lookup is the only network call
            in the feature and sends just the term. */}
        <div
          data-testid="rxcui-affordance"
          className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
        >
          {rxcui ? (
            <span
              data-testid="rxcui-current"
              className="inline-flex items-center gap-1"
            >
              RxNorm code{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {rxcui}
              </span>
              <button
                type="button"
                data-testid="rxcui-clear"
                className="btn-ghost px-1.5 py-0.5 text-xs"
                onClick={() => {
                  applyRxcui(null, null);
                  setRxCandidates(null);
                }}
              >
                Clear
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="rxcui-lookup"
              className="btn-ghost px-2 py-0.5 text-xs"
              onClick={findRxcui}
              disabled={rxLoading || !name.trim()}
            >
              {rxLoading ? "Looking up…" : "Find RxNorm code"}
            </button>
          )}
        </div>
        {rxError && (
          <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {rxError}
          </p>
        )}
        {rxCandidates && rxCandidates.length > 0 && !rxcui && (
          <div
            data-testid="rxcui-candidates"
            className="mt-1.5 space-y-1 rounded-lg border border-slate-200 p-2 dark:border-slate-700"
          >
            {rxCandidates.map((c) => (
              <div
                key={c.rxcui}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="text-slate-600 dark:text-slate-300">
                  {c.name || "(unnamed)"}{" "}
                  <span className="text-slate-400 dark:text-slate-500">
                    · {c.rxcui}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`rxcui-use-${c.rxcui}`}
                  className="btn-ghost px-2 py-0.5 text-xs"
                  onClick={() => void confirmRxcui(c.rxcui)}
                >
                  Use
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {candidateInteractions.length > 0 && (
        <div
          data-testid="interaction-notice"
          className="sm:col-span-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">
                Possible interaction
                {candidateInteractions.length > 1 ? "s" : ""} with your current
                stack
              </p>
              {candidateInteractions.map((hit) => (
                <p
                  key={hit.dedupeKey}
                  className="text-amber-700 dark:text-amber-300"
                >
                  <span className="font-medium">
                    {SEVERITY_LABEL[hit.severity]}:
                  </span>{" "}
                  {interactionTitle(hit)} — {hit.mechanism}
                </p>
              ))}
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Informational only — discuss with your prescriber or pharmacist.
                You can still save this item.
              </p>
            </div>
          </div>
        </div>
      )}

      {candidateFoodInteractions.length > 0 && (
        <div
          data-testid="food-notice"
          className="sm:col-span-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <div className="flex items-start gap-1.5">
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">Food guidance for this item</p>
              {candidateFoodInteractions.map((hit) => (
                <div
                  key={hit.key}
                  className="text-amber-700 dark:text-amber-300"
                >
                  <p>
                    <span className="font-medium">{hit.food}:</span>{" "}
                    {foodGuidanceLine(hit)}
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {foodGuidanceDetail(hit)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
          <input
            id={`supp-situation-${fid}`}
            name="situation"
            list="situation-options"
            defaultValue={s?.situation ?? ""}
            className="input"
            placeholder="e.g. Illness"
          />
          <datalist id="situation-options">
            {SUGGESTED_SITUATIONS.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>
      )}

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

      {/* Medication-only identity + as-needed */}
      {kind === "medication" && (
        <div className="sm:col-span-2 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 dark:border-slate-800">
          <div>
            <label className="label" htmlFor={`supp-prescriber-${fid}`}>
              Prescriber
            </label>
            <input
              id={`supp-prescriber-${fid}`}
              name="prescriber"
              defaultValue={s?.prescriber ?? ""}
              className="input"
              placeholder="e.g. Dr. Rivera"
            />
          </div>
          <div>
            <label className="label" htmlFor={`supp-pharmacy-${fid}`}>
              Pharmacy
            </label>
            <input
              id={`supp-pharmacy-${fid}`}
              name="pharmacy"
              defaultValue={s?.pharmacy ?? ""}
              className="input"
              placeholder="e.g. Walgreens #1234"
            />
          </div>
          <div>
            <label className="label" htmlFor={`supp-rx-${fid}`}>
              Rx number
            </label>
            <input
              id={`supp-rx-${fid}`}
              name="rx_number"
              defaultValue={s?.rx_number ?? ""}
              className="input"
              placeholder="e.g. RX7654321"
            />
          </div>
          <div>
            <label className="label" htmlFor={`supp-provider-${fid}`}>
              Provider / pharmacy
            </label>
            {/* Provider picker: create-on-type from the shared
                registry via the page's <datalist id="provider-names">. */}
            <input
              id={`supp-provider-${fid}`}
              name="provider"
              list="provider-names"
              defaultValue={s?.provider_name ?? ""}
              className="input"
              placeholder="e.g. Sample Care East"
            />
            {/* Round-trip the loaded link so an untouched field keeps its id (#601). */}
            {s && (
              <>
                <input
                  type="hidden"
                  name="provider_id"
                  value={s.provider_id ?? ""}
                />
                <input
                  type="hidden"
                  name="provider_loaded"
                  value={s.provider_name ?? ""}
                />
              </>
            )}
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                name="as_needed"
                value="1"
                checked={asNeeded}
                onChange={(e) => setAsNeeded(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
              />
              As needed (PRN) — no scheduled reminders
            </label>
          </div>
        </div>
      )}

      {/* Missed-dose escalation (critical medications) */}
      <div className="sm:col-span-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            name="critical"
            value="1"
            data-testid={`supp-critical-${fid}`}
            checked={critical}
            onChange={(e) => setCritical(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
          />
          Critical medication — escalate a missed dose
        </label>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          If a reminder for this dose goes unconfirmed, send a follow-up nudge
          (optionally to a second chat, e.g. a caregiver).
        </p>
        {critical && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor={`supp-escalate-after-${fid}`}>
                Escalate after (minutes)
              </label>
              <input
                id={`supp-escalate-after-${fid}`}
                name="escalate_after_min"
                type="number"
                min={1}
                defaultValue={s?.escalate_after_min ?? ""}
                className="input"
                placeholder="120"
              />
            </div>
            <div>
              <label className="label" htmlFor={`supp-escalate-chat-${fid}`}>
                Escalation chat ID (optional)
              </label>
              <input
                id={`supp-escalate-chat-${fid}`}
                name="escalate_chat_id"
                defaultValue={s?.escalate_chat_id ?? ""}
                className="input"
                placeholder="defaults to this profile’s chat"
              />
            </div>
          </div>
        )}
      </div>

      {/* Refill tracking */}
      <div className="sm:col-span-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Refill tracking (optional)
        </label>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Track units on hand to see “≈N days left” and get a refill nudge when
          you’re running low. Leave the quantity blank to skip tracking.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`supp-qty-${fid}`}>
              Quantity on hand
            </label>
            <input
              id={`supp-qty-${fid}`}
              name="quantity_on_hand"
              type="number"
              min={0}
              step="any"
              defaultValue={
                s?.quantity_on_hand != null
                  ? Math.max(0, s.quantity_on_hand)
                  : ""
              }
              className="input"
              placeholder="e.g. 90 pills"
            />
            {/* The value the form LOADED with, so updateSupplement can compare-and-
                set the concurrently-decremented on-hand counter instead of blindly
                overwriting a dose logged while this form was open (issue #467). */}
            <input
              type="hidden"
              name="quantity_on_hand_loaded"
              value={
                s?.quantity_on_hand != null
                  ? Math.max(0, s.quantity_on_hand)
                  : ""
              }
            />
          </div>
          <div>
            <label className="label" htmlFor={`supp-qty-per-dose-${fid}`}>
              Units per dose
            </label>
            <input
              id={`supp-qty-per-dose-${fid}`}
              name="qty_per_dose"
              type="number"
              min={0}
              step="any"
              defaultValue={s?.qty_per_dose ?? 1}
              className="input"
              placeholder="1"
            />
          </div>
        </div>
      </div>

      {/* Doses */}
      <div className="sm:col-span-2">
        <label className="label">Doses</label>
        <datalist id="dosage-options">
          {entry?.dosages.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <div className="space-y-2">
          {doses.map((d, i) => (
            <div
              key={i}
              className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
            >
              <input
                list="dosage-options"
                value={d.amount}
                onChange={(e) => setDose(i, { amount: e.target.value })}
                className="input sm:w-28"
                placeholder="amount"
                aria-label="Amount"
              />
              <select
                value={d.time_of_day || "Anytime"}
                onChange={(e) => setDose(i, { time_of_day: e.target.value })}
                className="input sm:w-32"
                aria-label="Time of day"
              >
                {TIME_BUCKETS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={d.food_timing}
                onChange={(e) =>
                  setDose(i, { food_timing: e.target.value as FoodTiming })
                }
                className="input col-span-2 sm:col-auto sm:w-40"
                aria-label="Food timing"
              >
                {FOOD_TIMINGS.map((ft) => (
                  <option key={ft} value={ft}>
                    {FOOD_TIMING_LABELS[ft]}
                  </option>
                ))}
              </select>
              {doses.length > 1 && (
                <button
                  type="button"
                  onClick={() => setDoses((ds) => ds.filter((_, j) => j !== i))}
                  className="tap-target col-span-2 flex h-8 w-8 items-center justify-center justify-self-end rounded text-slate-300 hover:text-rose-500 sm:col-auto dark:text-slate-600 dark:hover:text-rose-400"
                  aria-label="Remove dose"
                >
                  <IconX className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setDoses((ds) => [...ds, emptyDose()])}
          className="mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          + Add dose (split across times)
        </button>
      </div>

      {/* Interactions with other supplements */}
      {others.length > 0 && (
        <div className="sm:col-span-2">
          <label className="label">Interactions</label>
          {pairRows.length > 0 && (
            <div className="space-y-2">
              {pairRows.map((p, i) => (
                <div
                  key={i}
                  className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
                >
                  <select
                    value={p.relation}
                    onChange={(e) =>
                      setPair(i, { relation: e.target.value as PairRelation })
                    }
                    className="input col-span-2 sm:col-auto sm:w-36"
                    aria-label="Relation"
                  >
                    <option value="separate">keep apart from</option>
                    <option value="with">take together with</option>
                  </select>
                  <select
                    value={p.otherId || others[0].id}
                    onChange={(e) =>
                      setPair(i, { otherId: Number(e.target.value) })
                    }
                    className="input col-span-2 sm:col-auto sm:w-40"
                    aria-label="Other supplement"
                  >
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <input
                    value={p.note}
                    onChange={(e) => setPair(i, { note: e.target.value })}
                    className="input sm:w-40"
                    placeholder="note (optional)"
                    aria-label="Note"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setPairRows((ps) => ps.filter((_, j) => j !== i))
                    }
                    className="tap-target flex h-8 w-8 items-center justify-center justify-self-end rounded text-slate-300 hover:text-rose-500 dark:text-slate-600 dark:hover:text-rose-400"
                    aria-label="Remove interaction"
                  >
                    <IconX className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() =>
              setPairRows((ps) => [
                ...ps,
                { otherId: others[0].id, relation: "separate", note: "" },
              ])
            }
            className="mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            + Add interaction
          </button>
        </div>
      )}

      <div className="sm:col-span-2">
        <label className="label" htmlFor={`supp-notes-${fid}`}>
          Notes
        </label>
        <textarea
          id={`supp-notes-${fid}`}
          name="notes"
          defaultValue={s?.notes ?? ""}
          className="input"
          rows={3}
        />
      </div>

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
