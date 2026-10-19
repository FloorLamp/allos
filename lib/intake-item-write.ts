import { sqlNow } from "@/lib/clock";
import { isRealIsoDate } from "@/lib/date";
import { db, today, writeTx } from "@/lib/db";
import { readDoseQuantity, unreadableDoseAmountMessage } from "@/lib/dri";
import {
  unreadableAmountMessage,
  type IngredientDraftResult,
  type IngredientWrite,
} from "@/lib/intake-ingredients";
import {
  createIntakeItemCore,
  insertIntakeDose,
} from "@/lib/intake-item-create";
import { orderIntakePair } from "@/lib/intake-pairs";
import type { PurposeWrite } from "@/lib/intake-purposes";
import {
  resolveExactPrescriberId,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import {
  ensureMedicationCourse,
  // The dose-schedule lifecycle core (#2131) — this action module holds no
  // retire/version SQL of its own.
  recordScheduleVersion,
  retireRemovedDoses,
  setCourseStartDate,
  setMedicationEndDate,
} from "@/lib/queries";
import { parseRxcuiIngredients, serializeRxcuiIngredients } from "@/lib/rxnorm";
import {
  deleteProfileSetting,
  getProfileAge,
  resolveSituationId,
} from "@/lib/settings";
// The ONE spelling of every key this form's round trip uses, and the one parse of the
// four JSON payloads it posts (#4666) — the writer side is lib/intake-form-fields.
import {
  CADENCE_KINDS,
  doseScheduleDiffers,
  normalizeWeekdays,
  type CadenceKind,
  type DoseSchedule,
} from "@/lib/intake-cadence";
import {
  parseIntakeDoses,
  parseIntakeIngredients,
  parseIntakePairs,
  parseIntakePurposes,
  type IntakeField,
  type IntakePairInput,
} from "@/lib/intake-form-fields";
import { intakeKindAffordances } from "@/lib/intake-kind-affordances";
import {
  collapseOnDemandDoses,
  CONDITIONS,
  OBLIGATIONS,
  WORKOUT_CONDITIONS,
  type CollapsibleDose,
} from "@/lib/intake-schedule";
import { isTrainingRelevant } from "@/lib/life-stage";
import { markOfferAsked } from "@/lib/offers";
import { strOrNull } from "@/lib/parse";
import { getDoseScheduleVersions } from "@/lib/queries";
import { updateIntakeSupplyCount } from "@/lib/queries/intake";
import { parseQuantityOnHand } from "@/lib/refill";
import { leftRefillTrackedSet, refillMarkerKey } from "@/lib/refill-nudge";
import type {
  IntakeCondition,
  IntakeItemKind,
  IntakeObligation,
} from "@/lib/types";
import { formError, formOk, type FormResult } from "@/lib/types";

// IntakeItem-level fields (timing/amount/food live on doses). Every key is read
// through `get`/`str`, whose parameter is the ONE field declaration in
// lib/intake-form-fields (#4666) — so renaming a key the form posts is a compile
// error here instead of a field that quietly stops arriving.
function fields(formData: FormData, todayStr: string) {
  const get = (k: IntakeField) => formData.get(k);
  const has = (k: IntakeField) => formData.has(k);
  const str = (k: IntakeField) => strOrNull(formData.get(k));
  const conditionRaw = String(get("condition") ?? "daily");
  const condition: IntakeCondition = CONDITIONS.includes(
    conditionRaw as IntakeCondition
  )
    ? (conditionRaw as IntakeCondition)
    : "daily";
  // The item's KIND is read before its obligation because the med guardrail depends
  // on it (see below): kind is clinical identity, and a medication's default is the
  // one obligation that carries a safety net.
  const kindEarly: IntakeItemKind =
    get("kind") === "medication" ? "medication" : "supplement";
  const kindAffordances = intakeKindAffordances(kindEarly);
  const defaultObligation = kindAffordances.defaultObligation;
  const obligationRaw = String(get("obligation") ?? defaultObligation);
  // A `may` item is on demand by construction (#1505 collapsed obligation into it), so
  // the old separate as-needed checkbox is gone: choosing May declares no dueness.
  const obligation: IntakeObligation = OBLIGATIONS.includes(
    obligationRaw as IntakeObligation
  )
    ? (obligationRaw as IntakeObligation)
    : defaultObligation;
  // CALENDAR cadence (#1602) — orthogonal to `condition` above and to `obligation`.
  // Each branch keeps ONLY its own fields so a user who tries weekly, picks days, then
  // switches back to daily doesn't leave a stale weekday list that would silently
  // re-narrow the schedule if the kind were ever changed back by another path.
  const cadenceKindRaw = String(get("cadence_kind") ?? "daily");
  const cadenceKind: CadenceKind = CADENCE_KINDS.includes(
    cadenceKindRaw as CadenceKind
  )
    ? (cadenceKindRaw as CadenceKind)
    : "daily";
  const cadenceWeekdays =
    cadenceKind === "weekly"
      ? normalizeWeekdays(
          String(get("cadence_weekdays") ?? "")
            .split(",")
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isInteger(n))
        )
      : null;
  const cadenceIntervalRaw = Number(get("cadence_interval_days"));
  const cadenceIntervalDays =
    cadenceKind === "interval" &&
    Number.isInteger(cadenceIntervalRaw) &&
    cadenceIntervalRaw >= 1
      ? cadenceIntervalRaw
      : null;
  const anchorRaw = String(get("cadence_anchor_date") ?? "").trim();
  const cadenceAnchorDate =
    cadenceKind === "interval" && isRealIsoDate(anchorRaw) ? anchorRaw : null;
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
  const indicationRaw = Number(get("indication_condition_id"));
  const indicationConditionIdRaw =
    Number.isInteger(indicationRaw) && indicationRaw > 0 ? indicationRaw : null;
  // Missed-dose escalation. Only a critical supplement carries an
  // escalation window/override; clear them when it's toggled off so a stale value
  // can't fire later. escalate_after_min is a positive minute count (else null →
  // the notifier's default).
  const critical = get("critical") === "1" || get("critical") === "on";
  const afterRaw = Number(get("escalate_after_min"));
  const escalateAfterMin =
    critical && Number.isInteger(afterRaw) && afterRaw > 0 ? afterRaw : null;
  const escalateChatId = critical ? str("escalate_chat_id") : null;
  // Refill tracking. quantity_on_hand is opt-in: a blank field
  // leaves it NULL (untracked). qty_per_dose defaults to 1 and is clamped
  // positive so days-of-supply math never divides by zero.
  const quantityOnHand = parseQuantityOnHand(get("quantity_on_hand"));
  const perDoseRaw = Number(get("qty_per_dose"));
  const qtyPerDose =
    Number.isFinite(perDoseRaw) && perDoseRaw > 0 ? perDoseRaw : 1;
  // Medication identity (CLINICAL, #1505): kind = 'medication' reveals the
  // prescriber/pharmacy/Rx fields; the medication-only columns are cleared for a
  // plain supplement so a kind flip can't leave stale data. Kind no longer decides
  // pushability — obligation does.
  const kind: IntakeItemKind = kindEarly;
  const isMed = kind === "medication";
  // Stack is a SUPPLEMENT affordance, cleared for a medication for the same reason the
  // medication-only columns below are cleared for a supplement: a kind flip must not
  // leave stale data, and the create core nulls this column from the SAME table
  // (intakeKindAffordances(...).stack). Without this the EDIT wrote a stack the CREATE
  // refuses, so a medication's shape depended on which door touched it last.
  const stack = kindAffordances.stack ? str("stack") : null;
  const prescriber = isMed ? str("prescriber") : null;
  const pharmacy = isMed ? str("pharmacy") : null;
  const rxNumber = isMed ? str("rx_number") : null;
  // Rx / OTC flag (issue #851). A medication carries it; a supplement is always 0.
  // The form submits an explicit 0/1 ("rx" hidden field it keeps in sync); when the
  // field is ABSENT (a lean caller like the quick-add), derive it the same way the
  // migration backfill does — a recorded prescriber or Rx number ⇒ Rx, else OTC.
  const rxRaw = get("rx");
  const rx = !isMed
    ? 0
    : rxRaw === "1" || rxRaw === "on"
      ? 1
      : rxRaw === "0"
        ? 0
        : prescriber || rxNumber
          ? 1
          : 0;
  // On-demand shape follows the obligation, not a second flag (#1505): `may` has no
  // dueness.
  // Unlike the old checkbox this is not medication-only — a `may` supplement
  // (magnesium, a preworkout) has exactly the same amount-only, take-when-you-want
  // shape, and pretending otherwise is what made "low priority" incoherent.
  const isOnDemand = obligation === "may";
  const isPrnMedication = isMed && isOnDemand;
  // PRN redose notice (issue #798). Only a PRN medication carries these; a non-PRN
  // item clears them so a kind/PRN flip can't leave a stale notice armed. The
  // interval/max are the user-CONFIRMED label numbers (pre-filled from
  // lib/prn-defaults but only ever the user's own number); a blank field stays NULL →
  // NO notice, ever (the liability line). redose_notice is the per-item opt-in, forced
  // OFF unless BOTH numbers are confirmed (an opt-in with nothing confirmed can never
  // fire, so it isn't stored as "on").
  const intervalRaw = Number(get("min_interval_hours"));
  const minIntervalHours =
    isPrnMedication && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : null;
  const maxRaw = Number(get("max_daily_count"));
  const maxDailyCount =
    isPrnMedication && Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : null;
  // Amount-aware daily maximum in mg (#1854), same confirm discipline: a PRN
  // item only, user-entered, blank/invalid stays NULL — the mg basis is then
  // simply unavailable and the counters fall back to counting doses. It does NOT
  // gate the redose opt-in (interval + count max remain that pair).
  const maxMgRaw = Number(get("max_daily_amount_mg"));
  const maxDailyAmountMg =
    isPrnMedication && Number.isFinite(maxMgRaw) && maxMgRaw > 0
      ? maxMgRaw
      : null;
  const redoseNotice =
    isPrnMedication &&
    minIntervalHours != null &&
    maxDailyCount != null &&
    (get("redose_notice") === "1" || get("redose_notice") === "on")
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
  // The start date, and whether it was posted AT ALL — a lean caller that omits the
  // field is not a person who cleared it. Validated here so the create and the save
  // cannot drift on what a usable start date is; the callers decide when to refuse.
  const hasStartedOn = has("started_on");
  const startedOnRaw = String(get("started_on") ?? "").trim();
  const startDateError =
    kind === "medication" &&
    hasStartedOn &&
    !!startedOnRaw &&
    (!isRealIsoDate(startedOnRaw) || startedOnRaw > todayStr)
      ? "Enter a valid start date that isn't in the future."
      : null;
  return {
    hasStartedOn,
    startedOnRaw,
    startDateError,
    cadenceKind,
    cadenceWeekdays,
    cadenceIntervalDays,
    cadenceAnchorDate,
    notes: str("notes"),
    brand: str("brand"),
    product: str("product"),
    stack,
    condition,
    obligation,
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
    isOnDemand,
    minIntervalHours,
    maxDailyCount,
    maxDailyAmountMg,
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
  kind: IntakeItemKind,
  raw: number | null
): number | null {
  if (kind !== "medication" || raw == null) return null;
  const row = db
    .prepare("SELECT id FROM conditions WHERE id = ? AND profile_id = ?")
    .get(raw, profileId) as { id: number } | undefined;
  return row ? row.id : null;
}

// A dose amount whose number cannot be read STOPS THE SAVE (#3153), exactly as an
// unreadable ingredient amount does. The dose amount is the number the upper-limit
// warnings are computed from, and every alternative to refusing stores a guess on a
// safety surface: "1,000 mg" used to land as a schema-valid ZERO that contributed
// nothing to a niacin total 28x over the limit, and "2,5 g" as ten times the dose
// meant. Storing null instead would be just as quiet — unlike an ingredient row, a
// dose keeps no `amount_text` alongside its reading, so nothing downstream could ever
// tell that a number had been dropped. Refusing is the only answer the person can see
// and correct. Returns the offending text (possibly "") or null when every dose reads.
// Takes only what it reads, so the collapsed doses both call sites pass fit whatever
// else they carry.
function unreadableDoseAmount(
  doses: readonly { amount: string | null }[]
): string | null {
  const bad = doses.find(
    (d) => readDoseQuantity(d.amount).kind === "unreadable"
  );
  return bad ? (bad.amount ?? "") : null;
}

// Replace all pairs involving `itemId` with the submitted set. Pairs carry no
// child data, so delete-and-reinsert is simpler than diffing and is correct from
// either item's edit form. Must run inside a transaction.
function reconcilePairs(
  itemId: number,
  pairs: IntakePairInput[],
  profileId: number
) {
  db.prepare("DELETE FROM intake_item_pairs WHERE a_id = ? OR b_id = ?").run(
    itemId,
    itemId
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO intake_item_pairs (a_id, b_id, relation, note) VALUES (?,?,?,?)`
  );
  // Only pair with intake items this profile owns — the other id comes from the
  // form and must not be trusted to reference the caller's own data.
  const owned = db.prepare(
    "SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?"
  );
  for (const p of pairs) {
    if (p.otherId === itemId) continue;
    if (!owned.get(p.otherId, profileId)) continue;
    // Normalize order so the pair is direction-independent (UNIQUE dedups; the
    // CHECK (a_id < b_id) requires it) — the one shared orderIntakePair helper.
    const [a, b] = orderIntakePair(itemId, p.otherId);
    ins.run(a, b, p.relation, p.note);
  }
}

// Replace an item's ingredient rows with the submitted set. Ingredients carry no child
// data and no identity of their own — they are ATTRIBUTES of the item, restated in
// full every time the form that owns them is saved — so delete-and-reinsert is both
// simpler than diffing and exactly right (the intake_item_pairs posture). A null
// `rows` is a form that posted no composition at all: leave what is stored alone. Must
// run inside a transaction; the caller has already proven the item belongs to this
// profile.
function reconcileIngredients(itemId: number, rows: IngredientWrite[] | null) {
  if (rows == null) return;
  db.prepare("DELETE FROM intake_item_ingredients WHERE item_id = ?").run(
    itemId
  );
  const ins = db.prepare(
    `INSERT INTO intake_item_ingredients (item_id, name, amount_text, amount, unit, sort)
     VALUES (?,?,?,?,?,?)`
  );
  rows.forEach((g, i) => {
    ins.run(itemId, g.name, g.amount_text, g.amount, g.unit, i);
  });
}

// Drop purpose rows naming a condition that is not this PROFILE's — the ownership
// check the pure normalizer cannot make. Same posture as
// resolveIndicationConditionId (#1052): an untrusted id is dropped, never stored and
// never an error, so a stale picker option cannot link one person's item to another
// person's condition.
function ownedPurposes(
  profileId: number,
  rows: PurposeWrite[] | null
): PurposeWrite[] | null {
  if (rows == null) return null;
  const owns = db.prepare(
    "SELECT 1 FROM conditions WHERE id = ? AND profile_id = ?"
  );
  return rows.filter(
    (r) => r.kind !== "condition" || !!owns.get(r.condition_id, profileId)
  );
}

// Replace an item's purpose rows with the submitted set. The reconcileIngredients
// posture verbatim: purposes are ATTRIBUTES of the item with no child data and no
// identity of their own, restated in full on every save, so delete-and-reinsert is
// both simpler than diffing and exactly right. A null `rows` leaves what is stored
// alone. Must run inside a transaction; the caller has already proven the item belongs
// to this profile.
function reconcilePurposes(itemId: number, rows: PurposeWrite[] | null) {
  if (rows == null) return;
  db.prepare("DELETE FROM intake_item_purposes WHERE item_id = ?").run(itemId);
  const ins = db.prepare(
    `INSERT INTO intake_item_purposes
       (item_id, kind, goal_key, condition_id, biomarker_key, direction, sort)
     VALUES (?,?,?,?,?,?,?)`
  );
  rows.forEach((p, i) => {
    ins.run(
      itemId,
      p.kind,
      p.goal_key,
      p.condition_id,
      p.biomarker_key,
      p.direction,
      i
    );
  });
}

// WHAT THE CREATE AND THE SAVE BOTH READ (#4666). The two actions spelled this block
// twice — the same four payload parses, the same two refusals, the same prescriber and
// indication resolution — and only what surrounds it differs (the shared bottle, the
// course, the on-hand compare-and-set). Returns the refusal to show, or the submission.
//
// ONE PRESCRIBER RESOLUTION, NOT TWO. The create used resolveProviderIdByName and the
// save resolveProviderOnEdit. The create posts neither `provider_id` nor
// `provider_loaded` (the form sends those only for an edit), and resolveProviderOnEdit
// with a null loaded id and a blank loaded name is exactly resolveProviderIdByName —
// a blank submitted name normalizes equal and returns the null loaded id, any other
// name differs and re-resolves. So the edit-safe call (#601) covers both doors.
function readIntakeSubmission(
  profileId: number,
  formData: FormData,
  f: ReturnType<typeof fields>
):
  | { error: string }
  | {
      doses: CollapsibleDose[];
      pairs: IntakePairInput[];
      ingredients: IngredientDraftResult | null;
      purposes: PurposeWrite[] | null;
      providerId: number | null;
      indicationConditionId: number | null;
    } {
  const get = (k: IntakeField) => formData.get(k);
  const doses = collapseOnDemandDoses(parseIntakeDoses(formData), f.isOnDemand);
  const badDoseAmount = unreadableDoseAmount(doses);
  if (badDoseAmount != null)
    return { error: unreadableDoseAmountMessage(badDoseAmount) };
  const ingredients = parseIntakeIngredients(formData);
  if (ingredients && !ingredients.ok)
    return {
      error: unreadableAmountMessage(ingredients.name, ingredients.amountText),
    };
  // Prescriber (#1051 semantics decision (a)): provider_id is the prescribing
  // INDIVIDUAL, resolved-or-created as one ("individual" — never the silent org
  // default that mints mistyped person rows), and kept as loaded unless the field was
  // actually changed (#601) so an unrelated edit cannot relink an ambiguously-named
  // prescriber to a freshly-coined duplicate. When the picker is left blank, fall back
  // to an EXISTING individual row matching the free-text prescriber exactly (never an
  // org, never a near-miss). NULL for supplements, so a kind flip clears a stale link.
  let providerId =
    f.kind === "medication"
      ? resolveProviderOnEdit(
          Number(get("provider_id")) || null,
          String(get("provider_loaded") ?? ""),
          String(get("provider") ?? ""),
          "individual"
        )
      : null;
  if (f.kind === "medication" && providerId == null && f.prescriber)
    providerId = resolveExactPrescriberId(f.prescriber);
  return {
    doses,
    pairs: parseIntakePairs(formData),
    ingredients,
    purposes: parseIntakePurposes(formData),
    providerId,
    indicationConditionId: resolveIndicationConditionId(
      profileId,
      f.kind,
      f.indicationConditionIdRaw
    ),
  };
}

export function addIntakeItemCore(
  profileId: number,
  formData: FormData,
  supplyId: number | null = null
): FormResult {
  const get = (k: IntakeField) => formData.get(k);
  const name = String(get("name") ?? "").trim();
  if (!name) return formError("Enter a name.");
  const todayStr = today(profileId);
  const f = fields(formData, todayStr);
  if (
    f.kind === "supplement" &&
    WORKOUT_CONDITIONS.includes(f.condition) &&
    !isTrainingRelevant(getProfileAge(profileId))
  ) {
    return formError(
      "Workout-based supplement schedules aren't available for this profile's age."
    );
  }
  // Created FROM a shared bottle (#1705): the item form's picker posts the bottle it was
  // seeded from, so "there's a shared bottle of D3 5000 IU; add it for my daughter" is
  // ONE step instead of create-then-find-the-link-control. Validated against the SAME
  // offerability rule the picker used (isLinkableSupply over the caller's own scope), so
  // a forged id can't attach this item to a household branch the caller can't reach — and
  // a linked item keeps NO private count (the phantom-double-supply invariant), which is
  // why quantity_on_hand is forced NULL below rather than trusted from the form.
  if (f.startDateError) return formError(f.startDateError);
  const sub = readIntakeSubmission(profileId, formData, f);
  if ("error" in sub) return formError(sub.error);
  const {
    doses,
    pairs,
    ingredients,
    purposes,
    providerId,
    indicationConditionId,
  } = sub;
  const created = writeTx(() => {
    // Link the situational item to its id-keyed situation ROW (#560), creating the
    // row if this is a new label; the free-text `situation` column is kept as a
    // denormalized fallback.
    const situationId = f.situation
      ? resolveSituationId(profileId, f.situation)
      : null;
    // Resolve the INVERSE pause link (#1296), creating the situation ROW if this is a
    // new label — the same get-or-create as the on-link, so a Pre-surgery pause and a
    // Pre-surgery on-link converge on ONE vocabulary row.
    const pauseSituationId = f.pauseSituation
      ? resolveSituationId(profileId, f.pauseSituation)
      : null;
    // The item, its doses and (for a medication) its opening course are ONE core call
    // (#4669) — this action no longer spells the intake_items column set. What the
    // form knows it passes; the kind's defaults, the Rx derivation, the redose-notice
    // coupling and the shared-bottle count rule live in the core.
    const base = {
      name,
      provenance: { source: "manual" } as const,
      notes: f.notes,
      condition: f.condition,
      obligation: f.obligation,
      brand: f.brand,
      product: f.product,
      stack: f.stack,
      situation: f.situation,
      situationId,
      pauseSituationId,
      critical: f.critical,
      escalateAfterMin: f.escalateAfterMin,
      escalateChatId: f.escalateChatId,
      quantityOnHand: f.quantityOnHand,
      qtyPerDose: f.qtyPerDose,
      supplyId,
      rxcui: f.rxcui,
      rxcuiIngredients: f.rxcuiIngredients,
      cadenceKind: f.cadenceKind,
      cadenceWeekdays: f.cadenceWeekdays,
      cadenceIntervalDays: f.cadenceIntervalDays,
      cadenceAnchorDate: f.cadenceAnchorDate,
      doses,
    };
    const outcome = createIntakeItemCore(
      profileId,
      f.kind === "medication"
        ? {
            ...base,
            kind: "medication",
            prescriber: f.prescriber,
            pharmacy: f.pharmacy,
            rxNumber: f.rxNumber,
            rx: f.rx,
            providerId,
            indicationConditionId,
            minIntervalHours: f.minIntervalHours,
            maxDailyCount: f.maxDailyCount,
            maxDailyAmountMg: f.maxDailyAmountMg,
            redoseNotice: f.redoseNotice,
            // Ensure-course-on-create: a new medication opens an initial course on the
            // stated date, or with an unknown start when the field is blank.
            course: {
              kind: "open",
              startedOn: f.startedOnRaw || null,
            },
          }
        : { ...base, kind: "supplement" }
    );
    if (!outcome.ok) return outcome;
    if (supplyId != null && formData.has("supply_count")) {
      updateIntakeSupplyCount(
        profileId,
        outcome.id,
        supplyId,
        parseQuantityOnHand(get("supply_count")),
        parseQuantityOnHand(get("supply_count_loaded"))
      );
    }
    if (get("supply_offer_seen") === "1")
      markOfferAsked(profileId, {
        familyId: "track-supply",
        itemId: outcome.id,
      });
    reconcilePairs(outcome.id, pairs, profileId);
    reconcileIngredients(outcome.id, ingredients?.ok ? ingredients.rows : null);
    // Purpose links (#2857). Inside the same write transaction as the item and its
    // composition, so an item and its declared "why" land together or not at all.
    reconcilePurposes(outcome.id, ownedPurposes(profileId, purposes));
    return outcome;
  });
  if (!created.ok) return formError(created.error);
  // A newly pooled item changes what the cabinet and its doors show.
  return formOk();
}

export function updateIntakeItemCore(
  profileId: number,
  formData: FormData
): FormResult {
  const profile = { id: profileId };
  const get = (k: IntakeField) => formData.get(k);
  const has = (k: IntakeField) => formData.has(k);
  const id = Number(get("id"));
  const missingItem = formError(
    get("kind") === "medication"
      ? "Couldn't find that medication."
      : "Couldn't find that supplement."
  );
  if (!id) return missingItem;
  const name = String(get("name") ?? "").trim();
  if (!name) return formError("Enter a name.");
  const todayStr = today(profile.id);
  const f = fields(formData, todayStr);
  if (f.startDateError) return formError(f.startDateError);
  const hasCourseId = has("course_id");
  const courseId = Number(get("course_id"));
  if (hasCourseId && (!Number.isInteger(courseId) || courseId <= 0)) {
    return formError("Couldn't find that medication course.");
  }
  // End date (#1140 Part D): the current course's `stopped_on`. Empty ⇒ active (no end);
  // a date ⇒ ended as of that date. Medications only; validated not-future here, routed
  // through the shared stop/restart cores below (never a raw stopped_on write).
  const hasEndDate = f.kind === "medication" && has("end_date");
  const endDateRaw = String(get("end_date") ?? "").trim();
  if (
    hasEndDate &&
    endDateRaw &&
    (!isRealIsoDate(endDateRaw) || endDateRaw > todayStr)
  ) {
    return formError("Enter an end date that isn't in the future.");
  }
  const sub = readIntakeSubmission(profile.id, formData, f);
  if ("error" in sub) return formError(sub.error);
  const {
    doses,
    pairs,
    ingredients,
    purposes,
    providerId,
    indicationConditionId,
  } = sub;
  // The on-hand value the form was LOADED with (issue #467): quantity_on_hand is a
  // concurrently-decremented counter, so we compare-and-set against this instead of
  // blindly writing the absolute submitted value (see resolveOnHandWrite).
  const loadedQuantityOnHand = parseQuantityOnHand(
    get("quantity_on_hand_loaded")
  );
  if (has("supply_count") && !has("supply_id"))
    return formError("Reload the item before saving its bottle count.");
  const expectedSupplyId = has("supply_id")
    ? Number(get("supply_id")) || null
    : undefined;
  const result = writeTx((tx) => {
    // Verify ownership before touching the supplement or its child rows — the
    // form id is untrusted. Bail (no-op) when it isn't owned. Also snapshot the
    // prior refill-tracked state (active + quantity_on_hand) so an edit that turns
    // quantity tracking off can clear the low-supply episode marker (issue #325).
    const owned = db
      .prepare(
        "SELECT active, quantity_on_hand, supply_id, created_at, kind, condition FROM intake_items WHERE id = ? AND profile_id = ?"
      )
      .get(id, profile.id) as
      | {
          active: number;
          quantity_on_hand: number | null;
          supply_id: number | null;
          created_at: string | null;
          kind: IntakeItemKind;
          condition: IntakeCondition;
        }
      | undefined;
    if (!owned) return false;
    if (
      f.kind === "supplement" &&
      WORKOUT_CONDITIONS.includes(f.condition) &&
      !isTrainingRelevant(getProfileAge(profile.id)) &&
      (owned.kind !== "supplement" || owned.condition !== f.condition)
    ) {
      return "workout-schedule-unavailable" as const;
    }
    // A medication can have several historical courses. The edit form submits the
    // specific current/latest course it displayed, and this scoped lookup prevents a
    // forged id from changing another medication or profile. Validate before any row
    // is mutated so a start date can never land after that course's stop date.
    if (f.kind === "medication" && f.hasStartedOn && hasCourseId) {
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
        f.startedOnRaw &&
        course.stopped_on &&
        f.startedOnRaw > course.stopped_on
      ) {
        return "start-after-stop" as const;
      }
    }
    // Compare-and-set the refill counter (issue #467): only honor the submitted
    // on-hand value when the user actually changed the field; otherwise keep the
    // current value (re-read here under the IMMEDIATE write lock), so a concurrent
    // dose decrement — e.g. a poll-sidecar Telegram ✅ tap — isn't clobbered by a
    // stale form save. Everything else on the row is still absolute last-write-wins.
    if (expectedSupplyId !== undefined && owned.supply_id !== expectedSupplyId)
      return "stale-supply" as const;
    const count =
      owned.supply_id == null
        ? updateIntakeSupplyCount(
            profile.id,
            id,
            null,
            f.quantityOnHand,
            loadedQuantityOnHand
          )
        : has("supply_count")
          ? updateIntakeSupplyCount(
              profile.id,
              id,
              owned.supply_id,
              parseQuantityOnHand(get("supply_count")),
              parseQuantityOnHand(get("supply_count_loaded"))
            )
          : { quantity: null };
    if (!count) return "stale-supply" as const;
    const effectiveQuantityOnHand =
      owned.supply_id == null ? count.quantity : null;

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
         SET name = ?, notes = ?, condition = ?, obligation = ?, brand = ?,
             product = ?, situation = ?, situation_id = ?, pause_situation_id = ?,
             stack = ?,
             critical = ?, escalate_after_min = ?, escalate_chat_id = ?,
             qty_per_dose = ?,
             kind = ?, prescriber = ?, pharmacy = ?, rx_number = ?, rx = ?,
             min_interval_hours = ?, max_daily_count = ?,
             max_daily_amount_mg = ?, redose_notice = ?,
             rxcui = ?, rxcui_ingredients = ?, provider_id = ?,
             indication_condition_id = ?,
             cadence_kind = ?, cadence_weekdays = ?,
             cadence_interval_days = ?, cadence_anchor_date = ?
       WHERE id = ? AND profile_id = ?`
    ).run(
      name,
      f.notes,
      f.condition,
      f.obligation,
      f.brand,
      f.product,
      f.situation,
      situationId,
      pauseSituationId,
      f.stack,
      f.critical,
      f.escalateAfterMin,
      f.escalateChatId,
      f.qtyPerDose,
      f.kind,
      f.prescriber,
      f.pharmacy,
      f.rxNumber,
      f.rx,
      f.minIntervalHours,
      f.maxDailyCount,
      f.maxDailyAmountMg,
      f.redoseNotice,
      f.rxcui,
      f.rxcuiIngredients,
      providerId,
      indicationConditionId,
      f.cadenceKind,
      f.cadenceWeekdays,
      f.cadenceIntervalDays,
      f.cadenceAnchorDate,
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
    // Bump updated_at only when the slot actually changes (#430): a re-time
    // (evening → morning) restarts the adherence-pattern window so the engine
    // stops re-accusing the OLD slot, but a pure amount/food edit leaves the
    // dose's lifetime — and its miss history — where it was. `IS NOT` compares
    // NULL-safely. The new stamp comes from the CLOCK SEAM (sqlNow, #1534) —
    // doseAdherenceSince truncates it to a calendar DAY and compares it against a
    // `today()`-derived window, so a real-clock stamp drifts a day across midnight.
    const upd = db.prepare(
      `UPDATE intake_item_doses
          SET amount = ?, time_of_day = ?, food_timing = ?, sort = ?,
              weekdays = ?, start_date = ?, end_date = ?,
              updated_at = CASE WHEN time_of_day IS NOT ? THEN ?
                                ELSE updated_at END
        WHERE id = ? AND item_id = ? AND retired = 0`
    );
    // The PRE-EDIT schedule of every dose being kept, read under the write lock before
    // any UPDATE lands (#1973). This is the version a schedule change closes: once the
    // row is overwritten the old rule is unrecoverable, which is precisely why the clamp
    // existed. Read as one statement rather than per dose — the form submits a handful.
    const priorSchedules = new Map<
      number,
      DoseSchedule & { created_at: string | null }
    >(
      (
        db
          .prepare(
            `SELECT d.id, d.created_at, d.amount, d.time_of_day, d.weekdays,
                    d.start_date, d.end_date
               FROM intake_item_doses d
               JOIN intake_items s ON s.id = d.item_id
              WHERE d.item_id = ? AND d.retired = 0 AND s.profile_id = ?`
          )
          .all(id, profile.id) as ({
          id: number;
          created_at: string | null;
        } & DoseSchedule)[]
      ).map((r) => [r.id, r])
    );
    // Which doses already have a recorded history, so a dose from any origin (an
    // importer insert, a seeded row, a pre-#1973 row this migration missed) gets its
    // PRE-EDIT schedule recorded before the new version is appended. Without that
    // backfill the new version would be the earliest one, and the resolver's
    // before-recorded-history fallback would judge every past day by the NEW rule.
    const historyByDose = getDoseScheduleVersions(profile.id);
    const keptIds: number[] = [];
    doses.forEach((d, i) => {
      if (d.id) {
        // NOTE the calendar columns are NOT part of the updated_at trigger above: a
        // re-time restarts the adherence-pattern window, but narrowing a dose to
        // Mondays or closing its window changes WHICH DAYS it is due, not the identity
        // of the slot — and resetting the window would erase the very history the
        // change is meant to be judged against. Adherence history is never rewritten
        // by an edit (#1602 keeps that invariant by construction).
        upd.run(
          d.amount,
          d.time_of_day,
          d.food_timing,
          i,
          d.weekdays ?? null,
          d.start_date ?? null,
          d.end_date ?? null,
          d.time_of_day,
          sqlNow(),
          d.id,
          id
        );
        keptIds.push(d.id);
        // Effective-date schedule and amount changes. Every earlier day keeps resolving
        // to the facts that applied then. Food timing and sort remain cosmetic, and the
        // separate updated_at rule above keeps amount-only edits from moving the slot's
        // adherence boundary.
        const prior = priorSchedules.get(d.id);
        if (prior && doseScheduleDiffers(prior, d)) {
          const priorVersions = historyByDose.get(d.id);
          if (!priorVersions || priorVersions.length === 0) {
            // Lazy backfill: the pre-edit rule, effective from the dose's birth. The
            // anchor is the same one migration 151 seeds from — the dose's created_at,
            // else the parent item's, else the epoch — so a backfilled history and a
            // migrated one are indistinguishable.
            const born = (
              prior.created_at ??
              owned.created_at ??
              "1970-01-01"
            ).slice(0, 10);
            recordScheduleVersion(d.id, born, prior, false);
          }
          recordScheduleVersion(d.id, todayStr, d);
        }
      } else {
        // A dose added by an edit is born today, through the SAME writer a created
        // item's doses go through (#4669) — stamped, and with its first schedule
        // version seeded so its own first change has something to close (#1973).
        keptIds.push(insertIntakeDose(id, d, todayStr, i));
      }
    });
    // A dose the user removed is RETIRED (kept, flagged) when adherence logs
    // reference it — hard-deleting would ON DELETE CASCADE away its entire taken
    // history — and hard-deleted only when no log ever pointed at it. The rule is
    // executed by the dose-lifecycle core (#2131) inside THIS transaction (the Tx
    // token), which also closes each retired dose's dueness window as of today so a
    // later Restore never re-judges the gap.
    retireRemovedDoses(tx, profile.id, id, keptIds, todayStr);
    reconcilePairs(id, pairs, profile.id);
    reconcileIngredients(id, ingredients?.ok ? ingredients.rows : null);
    reconcilePurposes(id, ownedPurposes(profile.id, purposes));
    // Ensure-course invariant: if this row is (or just became) a
    // medication, make sure it has at least one course. No-op when it already has
    // one or is a supplement. A missing start remains unknown.
    if (f.kind === "medication") {
      ensureMedicationCourse(profile.id, id, f.startedOnRaw || null);
      if (f.hasStartedOn && hasCourseId) {
        // Through the course core (#2132) inside THIS transaction (the Tx token) — the
        // course was validated above, so a refusal here is unreachable.
        setCourseStartDate(
          tx,
          profile.id,
          id,
          courseId,
          f.startedOnRaw || null
        );
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
          // Typed outcome (#2132): the ensure-course above guarantees a course exists,
          // so a refusal here means the med vanished mid-edit — surface it rather than
          // confirming a write that no-oped.
          const endOutcome = setMedicationEndDate(profile.id, id, endDateNorm);
          if (endOutcome === "not-found" || endOutcome === "no-course") {
            return "course-not-found" as const;
          }
          deleteProfileSetting(profile.id, refillMarkerKey(id));
        }
      }
    }
    return true;
  });
  if (result === "stale-supply")
    return formError(
      "The shared bottle changed. Reload before saving its count."
    );
  if (result === "course-not-found") {
    return formError("Couldn't find that medication course.");
  }
  if (result === "start-after-stop") {
    return formError("The start date must be on or before the stop date.");
  }
  if (result === "workout-schedule-unavailable") {
    return formError(
      "Workout-based supplement schedules aren't available for this profile's age."
    );
  }
  if (!result) return missingItem;
  return formOk();
}
