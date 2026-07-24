"use server";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, today, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  getActiveSituations,
  setActiveSituations,
  resolveSituationId,
  deleteProfileSetting,
  getSituations,
  setSituationIllnessType,
} from "@/lib/settings";
import { generateAndStoreSuggestions } from "@/lib/supplement-suggest";
import {
  decrementSupply,
  incrementSupply,
  ensureMedicationCourse,
  setMedicationActive,
  setMedicationEndDate,
} from "@/lib/queries";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
  resolveExactPrescriberId,
} from "@/lib/providers-db";
import {
  lookupRxNormCandidates,
  lookupRxNormIngredients,
  parseRxcuiIngredients,
  serializeRxcuiIngredients,
} from "@/lib/rxnorm";
import { orderIntakePair } from "@/lib/intake-pairs";
import { leftRefillTrackedSet, refillMarkerKey } from "@/lib/refill-nudge";
import { parseQuantityOnHand, resolveOnHandWrite } from "@/lib/refill";
import {
  intakeItemDoseIds,
  sweepIntakeItemMarkers,
} from "@/lib/intake-marker-cleanup";
import { withAiLogContext } from "@/lib/ai-log";
import {
  CONDITIONS,
  PRIORITIES,
  FOOD_TIMINGS,
  parseDosage,
  spreadDoseTimes,
  collapsePrnDoses,
} from "@/lib/supplement-schedule";
import { formError, formOk, type FormResult } from "@/lib/types";
import type {
  FoodTiming,
  PairRelation,
  SupplementCondition,
  SupplementKind,
  SupplementPriority,
} from "@/lib/types";
import { strOrNull } from "@/lib/parse";
import { dismissFinding } from "@/lib/queries";
import { SURGERY_BRIDGE_PREFIX } from "@/lib/surgery-bridge";
import { poorSleepOverrideKey } from "@/lib/derived-situations";
import { ADHERENCE_PREFIX } from "@/lib/adherence-patterns";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import { KEEP_APART_PREFIX } from "@/lib/intake-pairs";

// Both intake surfaces (#746): a shared dose/item write is kind-agnostic (it acts
// by id), so it can affect the Nutrition → Supplements tab AND the Medications
// page. Revalidate both plus the dashboard. Supplement-only writes (situations, AI
// suggestions, adherence dismissals) revalidate just "/nutrition" at their call
// site.
function revalidateIntake() {
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  revalidatePath("/");
}

// Supplement-level fields (timing/amount/food live on doses).
function fields(formData: FormData) {
  const str = (k: string) => strOrNull(formData.get(k));
  const conditionRaw = String(formData.get("condition") ?? "daily");
  const condition: SupplementCondition = CONDITIONS.includes(
    conditionRaw as SupplementCondition
  )
    ? (conditionRaw as SupplementCondition)
    : "daily";
  const priorityRaw = String(formData.get("priority") ?? "high");
  const priority: SupplementPriority = PRIORITIES.includes(
    priorityRaw as SupplementPriority
  )
    ? (priorityRaw as SupplementPriority)
    : "high";
  const situation = condition === "situational" ? str("situation") : null;
  // The INVERSE situational link (issue #1296) — "pause this item WHILE X is active".
  // Independent of `condition`: a plain `daily` medication can be held during
  // Pre-surgery, so it's read unconditionally (not gated on condition === situational).
  // A blank field clears the link.
  const pauseSituation = str("pause_situation");
  // Med → indication link (#1052): the condition this medication treats, chosen from
  // the "For condition…" picker (a conditions-list select). Medications only; a blank
  // value or a supplement clears it. Ownership is validated in the action before it's
  // written (an untrusted id is dropped to null).
  const indicationRaw = Number(formData.get("indication_condition_id"));
  const indicationConditionIdRaw =
    Number.isInteger(indicationRaw) && indicationRaw > 0 ? indicationRaw : null;
  // Missed-dose escalation. Only a critical supplement carries an
  // escalation window/override; clear them when it's toggled off so a stale value
  // can't fire later. escalate_after_min is a positive minute count (else null →
  // the notifier's default).
  const critical =
    formData.get("critical") === "1" || formData.get("critical") === "on";
  const afterRaw = Number(formData.get("escalate_after_min"));
  const escalateAfterMin =
    critical && Number.isInteger(afterRaw) && afterRaw > 0 ? afterRaw : null;
  const escalateChatId = critical ? str("escalate_chat_id") : null;
  // Refill tracking. quantity_on_hand is opt-in: a blank field
  // leaves it NULL (untracked). qty_per_dose defaults to 1 and is clamped
  // positive so days-of-supply math never divides by zero.
  const quantityOnHand = parseQuantityOnHand(formData.get("quantity_on_hand"));
  const perDoseRaw = Number(formData.get("qty_per_dose"));
  const qtyPerDose =
    Number.isFinite(perDoseRaw) && perDoseRaw > 0 ? perDoseRaw : 1;
  // Medication identity. kind = 'medication' reveals the
  // prescriber/pharmacy/Rx + as-needed fields; the medication-only columns are
  // cleared for a plain supplement so a kind flip can't leave stale data.
  const kind: SupplementKind =
    formData.get("kind") === "medication" ? "medication" : "supplement";
  const isMed = kind === "medication";
  const prescriber = isMed ? str("prescriber") : null;
  const pharmacy = isMed ? str("pharmacy") : null;
  const rxNumber = isMed ? str("rx_number") : null;
  // Rx / OTC flag (issue #851). A medication carries it; a supplement is always 0.
  // The form submits an explicit 0/1 ("rx" hidden field it keeps in sync); when the
  // field is ABSENT (a lean caller like the quick-add), derive it the same way the
  // migration backfill does — a recorded prescriber or Rx number ⇒ Rx, else OTC.
  const rxRaw = formData.get("rx");
  const rx = !isMed
    ? 0
    : rxRaw === "1" || rxRaw === "on"
      ? 1
      : rxRaw === "0"
        ? 0
        : prescriber || rxNumber
          ? 1
          : 0;
  const asNeeded =
    isMed &&
    (formData.get("as_needed") === "1" || formData.get("as_needed") === "on")
      ? 1
      : 0;
  // PRN redose notice (issue #798). Only a PRN medication carries these; a non-PRN
  // item clears them so a kind/PRN flip can't leave a stale notice armed. The
  // interval/max are the user-CONFIRMED label numbers (pre-filled from
  // lib/prn-defaults but only ever the user's own number); a blank field stays NULL →
  // NO notice, ever (the liability line). redose_notice is the per-item opt-in, forced
  // OFF unless BOTH numbers are confirmed (an opt-in with nothing confirmed can never
  // fire, so it isn't stored as "on").
  const intervalRaw = Number(formData.get("min_interval_hours"));
  const minIntervalHours =
    asNeeded && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : null;
  const maxRaw = Number(formData.get("max_daily_count"));
  const maxDailyCount =
    asNeeded && Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : null;
  const redoseNotice =
    asNeeded &&
    minIntervalHours != null &&
    maxDailyCount != null &&
    (formData.get("redose_notice") === "1" ||
      formData.get("redose_notice") === "on")
      ? 1
      : 0;
  // Cached RxNorm concept id (issue #144) — user-confirmed on the form; kept for both
  // kinds since supplement-drug interactions are a first-class case here.
  const rxcui = str("rxcui");
  // The confirmed concept's active-ingredient RxCUIs (issue #279), resolved by the
  // form at confirm time. Untrusted client text → parse/re-serialize through the
  // shape-checking codec (anything implausible is dropped); coupled to the code
  // (no rxcui ⇒ no ingredient cache, so a cleared code can't leave stale CUIs).
  const rxcuiIngredients = rxcui
    ? serializeRxcuiIngredients(parseRxcuiIngredients(str("rxcui_ingredients")))
    : null;
  return {
    notes: str("notes"),
    brand: str("brand"),
    product: str("product"),
    stack: str("stack"),
    condition,
    priority,
    situation,
    pauseSituation,
    critical: critical ? 1 : 0,
    escalateAfterMin,
    escalateChatId,
    quantityOnHand,
    qtyPerDose,
    kind,
    prescriber,
    pharmacy,
    rxNumber,
    rx,
    asNeeded,
    minIntervalHours,
    maxDailyCount,
    redoseNotice,
    rxcui,
    rxcuiIngredients,
    indicationConditionIdRaw,
  };
}

// Validate a submitted indication condition id belongs to the profile as a real
// condition (#1052); a medication only, else null. Untrusted form id → dropped.
function resolveIndicationConditionId(
  profileId: number,
  kind: SupplementKind,
  raw: number | null
): number | null {
  if (kind !== "medication" || raw == null) return null;
  const row = db
    .prepare("SELECT id FROM conditions WHERE id = ? AND profile_id = ?")
    .get(raw, profileId) as { id: number } | undefined;
  return row ? row.id : null;
}

interface DoseInput {
  id?: number;
  amount: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
}

// Parse the doses JSON the form submits. Always returns at least one dose so a
// supplement is never left without a schedule entry.
function parseDoses(formData: FormData): DoseInput[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(String(formData.get("doses") ?? "[]"));
  } catch {
    raw = [];
  }
  const arr = Array.isArray(raw) ? raw : [];
  const out: DoseInput[] = arr.map((d: any) => ({
    id: typeof d?.id === "number" ? d.id : undefined,
    amount: strOrNull(d?.amount),
    time_of_day: strOrNull(d?.time_of_day),
    food_timing: FOOD_TIMINGS.includes(d?.food_timing) ? d.food_timing : "any",
  }));
  return out.length
    ? out
    : [{ amount: null, time_of_day: null, food_timing: "any" }];
}

// Stamp created_at so the adherence-pattern window starts at the dose's real birth,
// not the parent item's (#430). SQLite forbids datetime('now') as an ADD COLUMN
// default, so the write path sets it explicitly.
const insertDoseStmt = () =>
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
     VALUES (?,?,?,?,?, datetime('now'))`
  );

// Insert a fresh set of doses for a supplement (used on add + accept). Must run
// inside a transaction.
function insertDoses(
  suppId: number,
  doses: {
    amount: string | null;
    time_of_day: string | null;
    food_timing: FoodTiming;
  }[]
) {
  const ins = insertDoseStmt();
  doses.forEach((d, i) =>
    ins.run(suppId, d.amount, d.time_of_day, d.food_timing, i)
  );
}

interface PairInput {
  otherId: number;
  relation: PairRelation;
  note: string | null;
}

// Parse the interactions JSON the form submits (relationships from the edited
// supplement to others).
function parsePairs(formData: FormData): PairInput[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(String(formData.get("pairs") ?? "[]"));
  } catch {
    raw = [];
  }
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .map((p: any) => ({
      otherId: Number(p?.otherId) || 0,
      relation: (p?.relation === "with" ? "with" : "separate") as PairRelation,
      note: strOrNull(p?.note),
    }))
    .filter((p) => p.otherId > 0);
}

// Replace all pairs involving `suppId` with the submitted set. Pairs carry no
// child data, so delete-and-reinsert is simpler than diffing and is correct from
// either supplement's edit form. Must run inside a transaction.
function reconcilePairs(suppId: number, pairs: PairInput[], profileId: number) {
  db.prepare("DELETE FROM intake_item_pairs WHERE a_id = ? OR b_id = ?").run(
    suppId,
    suppId
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
  );
  // Only pair with supplements this profile owns — the other id comes from the
  // form and must not be trusted to reference the caller's own data.
  const owned = db.prepare(
    "SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?"
  );
  for (const p of pairs) {
    if (p.otherId === suppId) continue;
    if (!owned.get(p.otherId, profileId)) continue;
    // Normalize order so the pair is direction-independent (UNIQUE dedups; the
    // CHECK (a_id < b_id) requires it) — the one shared orderIntakePair helper.
    const [a, b] = orderIntakePair(suppId, p.otherId);
    ins.run(a, b, p.relation, p.note);
  }
}

export async function addSupplement(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Enter a name.");
  const f = fields(formData);
  const todayStr = today(profile.id);
  const hasStartedOn = formData.has("started_on");
  const startedOnRaw = String(formData.get("started_on") ?? "").trim();
  if (
    f.kind === "medication" &&
    hasStartedOn &&
    ((!f.asNeeded && !startedOnRaw) ||
      (!!startedOnRaw &&
        (!isRealIsoDate(startedOnRaw) || startedOnRaw > todayStr)))
  ) {
    return formError(
      f.asNeeded
        ? "Enter a valid start date that isn't in the future."
        : "Enter a start date that isn't in the future."
    );
  }
  const doses = collapsePrnDoses(parseDoses(formData), f.asNeeded === 1);
  const pairs = parsePairs(formData);
  // Prescriber (#1051 semantics decision (a)): provider_id is the prescribing
  // INDIVIDUAL. The picker resolves-or-creates against the registry as an INDIVIDUAL
  // (type: "individual" — never the silent org default that mints mistyped person
  // rows). When the picker is left blank, fall back to resolving the free-text
  // prescriber into an EXISTING individual row (exact only; never an org, never a
  // near-miss). NULL for supplements.
  let providerId =
    f.kind === "medication"
      ? resolveProviderIdByName(
          String(formData.get("provider") ?? ""),
          "individual"
        )
      : null;
  if (f.kind === "medication" && providerId == null && f.prescriber) {
    providerId = resolveExactPrescriberId(f.prescriber);
  }
  const indicationConditionId = resolveIndicationConditionId(
    profile.id,
    f.kind,
    f.indicationConditionIdRaw
  );
  writeTx(() => {
    // Link the situational item to its id-keyed situation ROW (#560), creating the
    // row if this is a new label; the free-text `situation` column is kept as a
    // denormalized fallback.
    const situationId = f.situation
      ? resolveSituationId(profile.id, f.situation)
      : null;
    // Resolve the INVERSE pause link (#1296), creating the situation ROW if this is a
    // new label — the same get-or-create as the on-link, so a Pre-surgery pause and a
    // Pre-surgery on-link converge on ONE vocabulary row.
    const pauseSituationId = f.pauseSituation
      ? resolveSituationId(profile.id, f.pauseSituation)
      : null;
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, priority, brand, product, situation, situation_id,
            pause_situation_id, stack,
            critical, escalate_after_min, escalate_chat_id,
            quantity_on_hand, qty_per_dose,
            kind, prescriber, pharmacy, rx_number, rx, as_needed,
            min_interval_hours, max_daily_count, redose_notice,
            rxcui, rxcui_ingredients, provider_id, indication_condition_id, source, profile_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual',?)`
      )
      .run(
        name,
        f.notes,
        f.condition,
        f.priority,
        f.brand,
        f.product,
        f.situation,
        situationId,
        pauseSituationId,
        f.stack,
        f.critical,
        f.escalateAfterMin,
        f.escalateChatId,
        f.quantityOnHand,
        f.qtyPerDose,
        f.kind,
        f.prescriber,
        f.pharmacy,
        f.rxNumber,
        f.rx,
        f.asNeeded,
        f.minIntervalHours,
        f.maxDailyCount,
        f.redoseNotice,
        f.rxcui,
        f.rxcuiIngredients,
        providerId,
        indicationConditionId,
        profile.id
      );
    const suppId = Number(info.lastInsertRowid);
    insertDoses(suppId, doses);
    reconcilePairs(suppId, pairs, profile.id);
    // Ensure-course-on-create: a new medication opens an initial course
    // on the chosen date (today for quick-add). A no-op for supplements (kind
    // guard inside the helper).
    if (f.kind === "medication") {
      ensureMedicationCourse(
        profile.id,
        suppId,
        hasStartedOn ? startedOnRaw || null : f.asNeeded ? null : todayStr,
        !!f.asNeeded && (!hasStartedOn || !startedOnRaw)
      );
    }
  });
  revalidateIntake();
  return formOk();
}

export async function updateSupplement(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that supplement.");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Enter a name.");
  const f = fields(formData);
  const todayStr = today(profile.id);
  const hasStartedOn = formData.has("started_on");
  const startedOnRaw = String(formData.get("started_on") ?? "").trim();
  if (
    f.kind === "medication" &&
    hasStartedOn &&
    ((!f.asNeeded && !startedOnRaw) ||
      (!!startedOnRaw &&
        (!isRealIsoDate(startedOnRaw) || startedOnRaw > todayStr)))
  ) {
    return formError(
      f.asNeeded
        ? "Enter a valid start date that isn't in the future."
        : "Enter a start date that isn't in the future."
    );
  }
  const hasCourseId = formData.has("course_id");
  const courseId = Number(formData.get("course_id"));
  if (hasCourseId && (!Number.isInteger(courseId) || courseId <= 0)) {
    return formError("Couldn't find that medication course.");
  }
  // End date (#1140 Part D): the current course's `stopped_on`. Empty ⇒ active (no end);
  // a date ⇒ ended as of that date. Medications only; validated not-future here, routed
  // through the shared stop/restart cores below (never a raw stopped_on write).
  const hasEndDate = f.kind === "medication" && formData.has("end_date");
  const endDateRaw = String(formData.get("end_date") ?? "").trim();
  if (
    hasEndDate &&
    endDateRaw &&
    (!isRealIsoDate(endDateRaw) || endDateRaw > todayStr)
  ) {
    return formError("Enter an end date that isn't in the future.");
  }
  const doses = collapsePrnDoses(parseDoses(formData), f.asNeeded === 1);
  const pairs = parsePairs(formData);
  // The on-hand value the form was LOADED with (issue #467): quantity_on_hand is a
  // concurrently-decremented counter, so we compare-and-set against this instead of
  // blindly writing the absolute submitted value (see resolveOnHandWrite).
  const loadedQuantityOnHand = parseQuantityOnHand(
    formData.get("quantity_on_hand_loaded")
  );
  // Prescribing provider: medications only; NULL for supplements so
  // a kind flip back to supplement clears a stale link. Keep the loaded link unless
  // the field was actually changed (#601), so an unrelated edit can't relink an
  // ambiguously-named prescriber to a freshly-coined duplicate.
  let providerId =
    f.kind === "medication"
      ? resolveProviderOnEdit(
          Number(formData.get("provider_id")) || null,
          String(formData.get("provider_loaded") ?? ""),
          String(formData.get("provider") ?? ""),
          "individual"
        )
      : null;
  // As on add: an empty prescriber picker falls back to an exact free-text match
  // against an existing individual registry row (#1051), never an org / near-miss.
  if (f.kind === "medication" && providerId == null && f.prescriber) {
    providerId = resolveExactPrescriberId(f.prescriber);
  }
  const indicationConditionId = resolveIndicationConditionId(
    profile.id,
    f.kind,
    f.indicationConditionIdRaw
  );
  const result = writeTx(() => {
    // Verify ownership before touching the supplement or its child rows — the
    // form id is untrusted. Bail (no-op) when it isn't owned. Also snapshot the
    // prior refill-tracked state (active + quantity_on_hand) so an edit that turns
    // quantity tracking off can clear the low-supply episode marker (issue #325).
    const owned = db
      .prepare(
        "SELECT active, quantity_on_hand FROM intake_items WHERE id = ? AND profile_id = ?"
      )
      .get(id, profile.id) as
      { active: number; quantity_on_hand: number | null } | undefined;
    if (!owned) return false;
    // A medication can have several historical courses. The edit form submits the
    // specific current/latest course it displayed, and this scoped lookup prevents a
    // forged id from changing another medication or profile. Validate before any row
    // is mutated so a start date can never land after that course's stop date.
    if (f.kind === "medication" && hasStartedOn && hasCourseId) {
      const course = db
        .prepare(
          `SELECT c.stopped_on
             FROM medication_courses c
             JOIN intake_items ii ON ii.id = c.item_id
            WHERE c.id = ? AND c.item_id = ? AND ii.profile_id = ?
              AND ii.kind = 'medication'`
        )
        .get(courseId, id, profile.id) as
        { stopped_on: string | null } | undefined;
      if (!course) return "course-not-found" as const;
      if (
        startedOnRaw &&
        course.stopped_on &&
        startedOnRaw > course.stopped_on
      ) {
        return "start-after-stop" as const;
      }
    }
    // Compare-and-set the refill counter (issue #467): only honor the submitted
    // on-hand value when the user actually changed the field; otherwise keep the
    // current value (re-read here under the IMMEDIATE write lock), so a concurrent
    // dose decrement — e.g. a poll-sidecar Telegram ✅ tap — isn't clobbered by a
    // stale form save. Everything else on the row is still absolute last-write-wins.
    const effectiveQuantityOnHand = resolveOnHandWrite(
      f.quantityOnHand,
      loadedQuantityOnHand,
      owned.quantity_on_hand
    );

    // Re-resolve the situation link on edit so a re-typed/changed label re-keys to
    // (or creates) the matching situation ROW (#560); null when not situational.
    const situationId = f.situation
      ? resolveSituationId(profile.id, f.situation)
      : null;
    // Re-resolve the INVERSE pause link on edit (#1296) so a re-typed/changed label
    // re-keys to (or creates) the matching situation ROW; null clears it.
    const pauseSituationId = f.pauseSituation
      ? resolveSituationId(profile.id, f.pauseSituation)
      : null;
    db.prepare(
      `UPDATE intake_items
         SET name = ?, notes = ?, condition = ?, priority = ?, brand = ?,
             product = ?, situation = ?, situation_id = ?, pause_situation_id = ?,
             stack = ?,
             critical = ?, escalate_after_min = ?, escalate_chat_id = ?,
             quantity_on_hand = ?, qty_per_dose = ?,
             kind = ?, prescriber = ?, pharmacy = ?, rx_number = ?, rx = ?, as_needed = ?,
             min_interval_hours = ?, max_daily_count = ?, redose_notice = ?,
             rxcui = ?, rxcui_ingredients = ?, provider_id = ?,
             indication_condition_id = ?
       WHERE id = ? AND profile_id = ?`
    ).run(
      name,
      f.notes,
      f.condition,
      f.priority,
      f.brand,
      f.product,
      f.situation,
      situationId,
      pauseSituationId,
      f.stack,
      f.critical,
      f.escalateAfterMin,
      f.escalateChatId,
      effectiveQuantityOnHand,
      f.qtyPerDose,
      f.kind,
      f.prescriber,
      f.pharmacy,
      f.rxNumber,
      f.rx,
      f.asNeeded,
      f.minIntervalHours,
      f.maxDailyCount,
      f.redoseNotice,
      f.rxcui,
      f.rxcuiIngredients,
      providerId,
      indicationConditionId,
      id,
      profile.id
    );
    // Turning quantity tracking off removes the item from the refill-nudge tracked
    // set; drop its low-supply episode marker so a later re-track re-fires a fresh
    // nudge instead of being silenced by a stale marker (issue #325). An edit never
    // changes `active`, so the prior active flag carries through unchanged.
    if (
      leftRefillTrackedSet(
        { active: !!owned.active, quantityOnHand: owned.quantity_on_hand },
        { active: !!owned.active, quantityOnHand: effectiveQuantityOnHand }
      )
    ) {
      deleteProfileSetting(profile.id, refillMarkerKey(id));
    }
    // Reconcile doses: update those with an id, insert new ones, and remove the
    // rest from the schedule. Updating in place (rather than delete-all +
    // re-insert) preserves the adherence logs keyed on dose_id AND keeps any
    // in-flight Telegram reminder buttons (which carry the dose id) valid across
    // a brand/dosage edit. The retired = 0 guard keeps a forged/stale id from
    // rewriting a retired dose's row, which history still displays through.
    const ins = insertDoseStmt();
    // Bump updated_at only when the slot actually changes (#430): a re-time
    // (evening → morning) restarts the adherence-pattern window so the engine
    // stops re-accusing the OLD slot, but a pure amount/food edit leaves the
    // dose's lifetime — and its miss history — where it was. `IS NOT` compares
    // NULL-safely.
    const upd = db.prepare(
      `UPDATE intake_item_doses
          SET amount = ?, time_of_day = ?, food_timing = ?, sort = ?,
              updated_at = CASE WHEN time_of_day IS NOT ? THEN datetime('now')
                                ELSE updated_at END
        WHERE id = ? AND item_id = ? AND retired = 0`
    );
    const keptIds: number[] = [];
    doses.forEach((d, i) => {
      if (d.id) {
        upd.run(
          d.amount,
          d.time_of_day,
          d.food_timing,
          i,
          d.time_of_day,
          d.id,
          id
        );
        keptIds.push(d.id);
      } else {
        const info = ins.run(id, d.amount, d.time_of_day, d.food_timing, i);
        keptIds.push(Number(info.lastInsertRowid));
      }
    });
    // A dose the user removed is RETIRED (kept, flagged) when adherence logs
    // reference it — hard-deleting would ON DELETE CASCADE away its entire taken
    // history — and hard-deleted only when no log ever pointed at it. Already-
    // retired rows are never resubmitted by the form (it only sees live doses),
    // so both statements skip them to leave history untouched.
    const placeholders = keptIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE intake_item_doses SET retired = 1
        WHERE item_id = ? AND retired = 0 AND id NOT IN (${placeholders})
          AND EXISTS (SELECT 1 FROM intake_item_logs l
                       WHERE l.dose_id = intake_item_doses.id)`
    ).run(id, ...keptIds);
    db.prepare(
      `DELETE FROM intake_item_doses
        WHERE item_id = ? AND retired = 0 AND id NOT IN (${placeholders})`
    ).run(id, ...keptIds);
    reconcilePairs(id, pairs, profile.id);
    // Ensure-course invariant: if this row is (or just became) a
    // medication, make sure it has at least one course. No-op when it already has
    // one or is a supplement. Uses the created_at-date fallback (no explicit start
    // date on an edit).
    if (f.kind === "medication") {
      ensureMedicationCourse(
        profile.id,
        id,
        hasStartedOn ? startedOnRaw || null : null,
        !!f.asNeeded && hasStartedOn && !startedOnRaw
      );
      if (hasStartedOn && hasCourseId) {
        db.prepare(
          `UPDATE medication_courses
              SET started_on = ?
            WHERE id = ? AND item_id = ?
              AND EXISTS (
                SELECT 1 FROM intake_items ii
                 WHERE ii.id = medication_courses.item_id
                   AND ii.profile_id = ? AND ii.kind = 'medication'
              )`
        ).run(startedOnRaw || null, courseId, id, profile.id);
      }
      // End date (#1140 Part D): apply only when it actually changed vs the current
      // latest-course state (re-read under the write lock, the #467 lifecycle-field
      // posture) — a no-op edit never churns course history. Setting stops as of that
      // date; clearing reactivates; both go through the shared cores (setMedicationEndDate),
      // never a raw column write, so the invariant holds and a Restart-after re-fires a
      // fresh refill nudge (#325).
      if (hasEndDate) {
        const endDateNorm = endDateRaw || null;
        const cur = db
          .prepare(
            `SELECT stopped_on FROM medication_courses
              WHERE item_id = ? ORDER BY started_on DESC, id DESC LIMIT 1`
          )
          .get(id) as { stopped_on: string | null } | undefined;
        if ((cur?.stopped_on ?? null) !== endDateNorm) {
          setMedicationEndDate(profile.id, id, endDateNorm);
          deleteProfileSetting(profile.id, refillMarkerKey(id));
        }
      }
    }
    return true;
  });
  if (result === "course-not-found") {
    return formError("Couldn't find that medication course.");
  }
  if (result === "start-after-stop") {
    return formError("The start date must be on or before the stop date.");
  }
  if (!result) return formError("Couldn't find that supplement.");
  revalidateIntake();
  return formOk();
}

// The three states one dose can be in for a day: taken, deliberately skipped
// (issue #232), or clear (no log row). The web check-off is a tri-state over
// these; the Telegram buttons are one-way resolves.
type DoseStatusTarget = "taken" | "skipped" | "clear";

// Set one dose to an explicit target status for `date`, keeping on-hand supply in
// lock-step. ONLY a taken row consumes supply, so crossing the taken boundary is
// the sole thing that moves the count: clear/skipped → taken decrements, taken →
// clear/skipped re-increments (the symmetric restore #232 calls for), and a
// skipped ↔ clear flip never touches supply. The amount is snapshotted on a taken
// row (history must survive a later dosage edit) and NULL on a skipped one
// (nothing was consumed). Verifies the dose belongs to a supplement this profile
// owns and uses the row's own item_id, never trusting the caller; a retired
// dose is refused (the UI never renders a control for one). Idempotent per target.
function applyDoseStatus(
  profileId: number,
  doseId: number,
  date: string,
  target: DoseStatusTarget
): void {
  // One IMMEDIATE transaction (#468). Since #797 dropped UNIQUE(dose_id, date) — the
  // constraint that used to make a concurrent second INSERT a caught no-op — this
  // SELECT-then-write must be atomic itself, or two concurrent web replicas (or the
  // notify sidecar) could each insert a taken row for one scheduled (dose,date) and
  // double-decrement supply. BEGIN IMMEDIATE serializes writers, so the exists-check
  // is accurate and one-taken-row-per-(dose,date) holds for a scheduled dose. (The
  // PRN multiples path is logAdministration, a different core.)
  writeTx(() => {
    const dose = db
      .prepare(
        `SELECT item_id, amount FROM intake_item_doses
       WHERE id = ? AND retired = 0
         AND item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
      )
      .get(doseId, profileId) as
      { item_id: number; amount: string | null } | undefined;
    if (!dose) return;
    const existing = db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: DoseStatusTarget } | undefined;
    const current: DoseStatusTarget = existing ? existing.status : "clear";
    if (current === target) return;

    if (target === "clear") {
      db.prepare(
        "DELETE FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      ).run(doseId, date);
      if (current === "taken") incrementSupply(profileId, dose.item_id);
      return;
    }

    if (!existing) {
      // A taken check-off stamps given_at = now (the tap moment ≈ intake time), so
      // the med card's "last …" line has a time; a skip records no intake.
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status, given_at)
         VALUES (?,?,?,?,?, CASE WHEN ? = 'taken' THEN datetime('now') ELSE NULL END)`
      ).run(
        doseId,
        dose.item_id,
        date,
        target === "taken" ? dose.amount : null,
        target,
        target
      );
      if (target === "taken") decrementSupply(profileId, dose.item_id);
      return;
    }

    db.prepare(
      "UPDATE intake_item_logs SET status = ?, amount = ? WHERE dose_id = ? AND date = ?"
    ).run(target, target === "taken" ? dose.amount : null, doseId, date);
    // Cross the taken boundary in supply.
    if (current !== "taken" && target === "taken") {
      decrementSupply(profileId, dose.item_id);
    } else if (current === "taken" && target !== "taken") {
      incrementSupply(profileId, dose.item_id);
    }
  });
}

// Set a single dose's status for today to an explicit target — the web
// tri-state's write path (taken / skipped / clear). #232
//
// Cross-profile (#858/#1373): a multi-view Medications board confirms a household
// member's scheduled dose without switching the acting profile — the board posts an
// explicit `profileId`, and the write gates on the TARGET via requireProfileWriteAccess
// (the #31 cross-profile gate) instead of the active-profile requireWriteAccess. Absent
// (the acting board / single-view / Supplements row), the active profile is used, so
// those callers are byte-identical. applyDoseStatus scopes the dose to that profile, so
// a dose the target doesn't own is a safe no-op.
export async function setDoseStatus(formData: FormData): Promise<FormResult> {
  const targetProfile = Number(formData.get("profileId"));
  let profileId: number;
  if (Number.isInteger(targetProfile) && targetProfile > 0) {
    await requireProfileWriteAccess(targetProfile);
    profileId = targetProfile;
  } else {
    profileId = (await requireWriteAccess()).profile.id;
  }
  const doseId = Number(formData.get("dose_id"));
  const target = String(formData.get("status") ?? "");
  if (
    !doseId ||
    (target !== "taken" && target !== "skipped" && target !== "clear")
  ) {
    return formError("Couldn't update this dose.");
  }
  applyDoseStatus(profileId, doseId, today(profileId), target);
  revalidateIntake();
  return formOk();
}

// Toggle a single dose's TAKEN log for today (taken ↔ clear). A skipped dose
// (issue #232) counts as "not taken", so this flips it to taken. Kept as the
// dedicated take toggle; setDoseStatus is the general tri-state path.
export async function toggleTaken(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return formError("Couldn't find that dose.");
  const date = today(profile.id);
  const existing = db
    .prepare(
      "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { status: DoseStatusTarget } | undefined;
  applyDoseStatus(
    profile.id,
    doseId,
    date,
    existing?.status === "taken" ? "clear" : "taken"
  );
  revalidateIntake();
  return formOk();
}

export async function toggleActive(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that item.");
  const row = db
    .prepare(
      "SELECT active, kind, quantity_on_hand FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as
    | { active: number; kind: string; quantity_on_hand: number | null }
    | undefined;
  if (!row) return formError("Couldn't find that item.");
  const nextActive: 0 | 1 = row.active ? 0 : 1;
  if (row.kind === "medication") {
    // Keep the medication's course history in sync with the plain Pause/Resume
    // toggle so `active` can't desync from the open-course state.
    setMedicationActive(profile.id, id, nextActive, today(profile.id));
  } else {
    db.prepare(
      "UPDATE intake_items SET active = ? WHERE id = ? AND profile_id = ?"
    ).run(nextActive, id, profile.id);
  }
  // Pausing a tracked item removes it from the refill-nudge tracked set; drop its
  // low-supply episode marker so resuming it while still low re-fires a fresh nudge
  // (issue #325). No-op on resume, or when the item wasn't refill-tracked.
  if (
    leftRefillTrackedSet(
      { active: !!row.active, quantityOnHand: row.quantity_on_hand },
      { active: !!nextActive, quantityOnHand: row.quantity_on_hand }
    )
  ) {
    deleteProfileSetting(profile.id, refillMarkerKey(id));
  }
  revalidateIntake();
  return formOk();
}

export async function deleteSupplement(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Capture the intake item + its whole cascade (doses, pairs, adherence logs,
  // medication courses, side effects) into the undo holding table and delete it in
  // one transaction (issue #30), so a mis-tapped supplement/med can be restored
  // from the toast. NOTE: refill supply decrements are NOT recomputed on Undo — the
  // item's quantity_on_hand is restored verbatim as it stood at delete time.
  // Enumerate the item's dose ids BEFORE the cascade delete removes them, so we can
  // sweep their per-dose escalation markers below (profile-scoped via the parent
  // JOIN).
  const doseIds = intakeItemDoseIds(profile.id, id);
  const undoId = captureDelete("intake-item", profile.id, id);
  // Drop the item's low-supply episode marker with it (issue #203) AND its per-dose
  // escalation dedup markers (issue #328). Both are dead rows rather than wrong
  // suppression — ids never recycle — but the delete seam sweeping ONE marker family
  // and not the other was inconsistency, not principle. Shared with the Data → Manage
  // bulk delete so both paths sweep both families identically.
  sweepIntakeItemMarkers(profile.id, id, doseIds);
  revalidateIntake();
  return { undoId };
}

export async function toggleSituation(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim();
  if (!situation) return formError("Couldn't find that situation.");
  const active = new Set(getActiveSituations(profile.id));
  if (active.has(situation)) active.delete(situation);
  else active.add(situation);
  setActiveSituations(profile.id, [...active]);
  revalidateIntake();
  return formOk();
}

// Accept a surgery-bridge suggestion (issue #1299): ACTIVATE the named situation
// (Pre-surgery / Post-op) idempotently — the consented producer for #1296's pause.
// Distinct from toggleSituation (which flips): accepting the same chip twice is a
// no-op, never an accidental deactivation. Suggest-only — this runs only from the
// user's confirm, never derived-auto.
export async function activateSurgerySituation(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim();
  if (!situation) return formError("Couldn't find that situation.");
  const active = new Set(getActiveSituations(profile.id));
  active.add(situation);
  setActiveSituations(profile.id, [...active]);
  revalidateIntake();
  return formOk();
}

// Clear a surgery-bridge situation (issue #1299): DEACTIVATE the named situation
// (the "clear Pre-surgery — N items resume" half of the post-op transition). The hold
// lifts automatically the moment the situation deactivates (#1296), so held items
// resume the same day. Idempotent — clearing an already-inactive situation is a no-op.
export async function clearSurgerySituation(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim();
  if (!situation) return formError("Couldn't find that situation.");
  const active = new Set(getActiveSituations(profile.id));
  active.delete(situation);
  setActiveSituations(profile.id, [...active]);
  revalidateIntake();
  return formOk();
}

// Dismiss ONE surgery-bridge suggestion per-procedure (issue #1299 / #203): stores the
// visit-id+phase key on the shared suppression bus so dismissing this surgery's chip
// never silences next year's (ids never recycle; a deleted visit leaves a dead row).
export async function dismissSurgeryBridge(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const key = String(formData.get("key") ?? "").trim();
  if (!key.startsWith(SURGERY_BRIDGE_PREFIX))
    return formError("Couldn't dismiss that suggestion.");
  dismissFinding(profile.id, key);
  revalidateIntake();
  return formOk();
}

// The poor-sleep derived-context "Not today" override (#1292): suppress the DERIVED
// contribution for TODAY only. Writes a date-scoped suppression row on the shared bus
// (the same store the coaching-observation dismiss uses) under the registered
// poor-sleep-override prefix — so getEffectiveActiveSituations stops widening the active
// set with the measured Poor sleep name for today. Deliberately date-scoped: tomorrow's
// derived context re-evaluates fresh (a stale override never silences a later rough
// night). It suppresses only the derived contribution — a DECLARED Poor sleep toggle is
// cleared by its chip, never this — and is INDEPENDENT of the coaching card's own snooze
// (dismissing the supplement surfacing must not silence rest advice, #449). Auth-blind
// core (dismissFinding) behind the requireWriteAccess gate.
export async function dismissDerivedPoorSleep(): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  dismissFinding(profile.id, poorSleepOverrideKey(today(profile.id)));
  revalidateIntake();
  return formOk();
}

// Toggle a situation's illness_type flag (issue #799) — the situations-bar opt-in that
// makes a user situation ("Migraine", "Kid sick") a symptom-log container. Flips the
// current stored value; the dashboard symptom card + episode derivation key on flagged
// situations only. Also revalidates the dashboard where the card may (dis)appear.
export async function toggleSituationIllnessType(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim();
  if (!situation) return formError("Couldn't find that situation.");
  const current = getSituations(profile.id).find(
    (s) => s.name.toLowerCase() === situation.toLowerCase()
  );
  setSituationIllnessType(profile.id, situation, !(current?.illness_type ?? 0));
  revalidateIntake();
  revalidatePath("/");
  return formOk();
}

export interface SuggestState {
  ok: boolean;
  message: string;
}

// useFormState action: returns a result the form surfaces inline so AI failures
// (or "no new suggestions") aren't silent.
export async function generateSuggestions(
  _prev: SuggestState | null,
  formData: FormData
): Promise<SuggestState> {
  const { login, profile } = await requireWriteAccess();
  const feedback = String(formData.get("feedback") ?? "").trim() || undefined;
  const { inserted, note } = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => generateAndStoreSuggestions(profile.id, feedback)
  );
  revalidatePath("/nutrition");
  if (note) return { ok: false, message: note };
  return {
    ok: true,
    message:
      inserted > 0
        ? `Added ${inserted} suggestion${inserted === 1 ? "" : "s"}.`
        : "No new suggestions from your current data.",
  };
}

export async function acceptSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that suggestion.");
  const s = db
    .prepare(
      "SELECT * FROM intake_item_suggestions WHERE id = ? AND status = 'pending' AND profile_id = ?"
    )
    .get(id, profile.id) as
    | {
        name: string;
        dosage: string | null;
        time_of_day: string | null;
        food_timing: FoodTiming;
        condition: string;
        priority: string;
        brand: string | null;
        product: string | null;
        situation: string | null;
        rationale: string;
      }
    | undefined;
  if (!s) return formError("That suggestion is no longer available.");
  // Parse the free-text dosage ("5–10 g once daily") into a clean amount and
  // intake count, rather than dumping it all into one dose's amount.
  const parsed = parseDosage(s.dosage);
  const amount = parsed.amount ?? s.dosage;
  const time = s.time_of_day ?? parsed.timeOfDay ?? null;
  const times = spreadDoseTimes(parsed.perDay, time);
  writeTx(() => {
    // Link an accepted situational suggestion to its situation ROW (#560).
    const situationId =
      s.condition === "situational" && s.situation
        ? resolveSituationId(profile.id, s.situation)
        : null;
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, priority, brand, product, situation, situation_id, stack, source, profile_id)
         VALUES (?,?,?,?,?,?,?,?,?,'manual',?)`
      )
      .run(
        s.name,
        s.rationale,
        s.condition,
        s.priority,
        s.brand,
        s.product,
        s.situation,
        situationId,
        null,
        profile.id
      );
    const suppId = Number(info.lastInsertRowid);
    insertDoses(
      suppId,
      times.map((t) => ({
        amount,
        time_of_day: t,
        food_timing: s.food_timing ?? "any",
      }))
    );
    db.prepare(
      "UPDATE intake_item_suggestions SET status = 'accepted' WHERE id = ? AND profile_id = ?"
    ).run(id, profile.id);
  });
  revalidateIntake();
  return formOk();
}

export async function dismissSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that suggestion.");
  db.prepare(
    "UPDATE intake_item_suggestions SET status = 'dismissed' WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidatePath("/nutrition");
  return formOk();
}

// Look up RxNorm candidates for a free-text name (issue #144) — the ONLY network
// egress of the interaction feature, and it sends just the term (no PHI). Called
// from the item form's "Find RxNorm code" affordance; the user CONFIRMS a candidate,
// which fills the hidden `rxcui` field saved by add/updateSupplement. Degrades to []
// (name-only matching) on any timeout/error. requireWriteAccess gates it to a
// session with write access; nothing is stored here.
export async function lookupRxcui(
  name: string
): Promise<{ rxcui: string; name: string; score: number }[]> {
  await requireWriteAccess();
  return lookupRxNormCandidates(name);
}

// Resolve a confirmed RxCUI to its ACTIVE-INGREDIENT RxCUIs (issue #279) — the
// only other network egress of the interaction feature, and it sends just the CODE
// (no name, no PHI) to RxNav's `/rxcui/{id}/related?tty=IN`. Called by the item
// form when the user confirms a candidate: a combination product's product-level
// code never appears in the ingredient-keyed interaction datasets, so the resolved
// ingredient CUIs fill the hidden `rxcui_ingredients` field saved by add/
// updateSupplement and both matchers try each of them. Degrades to [] (product-
// rxcui + name matching) on any timeout/error. Nothing is stored here.
export async function lookupRxcuiIngredients(rxcui: string): Promise<string[]> {
  await requireWriteAccess();
  return lookupRxNormIngredients(rxcui);
}

// Dismiss an adherence-pattern observation (issue #45, domain 3): a weekday-specific
// or weekend miss cluster for a scheduled dose. Hides it through the shared
// findings-bus suppression store, keyed by its `adherence:<kind>:<doseId>…`
// dedupeKey. Guarded to the adherence namespace (like dismissTrainingObservation)
// so this action can only ever silence an adherence-pattern key; profile-scoped via
// dismissFinding.
export async function dismissAdherencePattern(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(ADHERENCE_PREFIX))
    return formError("Couldn't dismiss that observation.");
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/nutrition");
  return formOk();
}

// The finding namespaces the intake surfaces (#746: the Nutrition → Supplements
// tab AND the Medications page) render as dismissible OBSERVATIONS
// (issue #435): drug–drug interactions, pharmacogenomics cross-checks (#710),
// stack-total dietary limits, per-item food–drug guidance, and keep-apart pair
// warnings. Each also surfaces on Upcoming
// through the SAME shared findings-suppression bus keyed by the identical dedupeKey,
// so a dismiss here silences the Upcoming twin and vice versa ("dismiss once, silence
// everywhere", #227's page↔push principle applied page↔page). The scheduled
// dose-reminder / missed-dose escalation stay their own (deliberately un-suppressible)
// safety-tier machinery — these are calm observations, not safety reminders.
const INTAKE_FINDING_PREFIXES = [
  "interaction:",
  "pgx:",
  "dietary-limit:",
  "rda-adequacy:",
  "prn-max:",
  // Ototoxic-medication awareness (#717) — rendered dismissible by IntakeWarnings
  // since it shipped, but its namespace was missing here, so the card's dismiss
  // always refused. Registered alongside the new allergy namespace (#1029 fix-up).
  "ototoxic:",
  // Drug-allergy × med cross-check (#1029) — `allergy-med:<allergyId>-<itemId>`.
  "allergy-med:",
  FOOD_TIMING_PREFIX,
  KEEP_APART_PREFIX,
];

// Dismiss an intake observational finding through the shared findings-bus
// suppression store. Guarded to the intake-surface namespaces above, so it can only
// silence one of those keys (never an arbitrary finding); profile-scoped via
// dismissFinding. One action for the four page surfaces (their divs post their own
// dedupeKey), mirroring how each page's dismiss action guards its own domain.
export async function dismissIntakeFinding(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!INTAKE_FINDING_PREFIXES.some((p) => dedupeKey.startsWith(p)))
    return formError("Couldn't dismiss that finding.");
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  return formOk();
}
