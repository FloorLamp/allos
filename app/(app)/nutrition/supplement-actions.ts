"use server";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { requireScope } from "@/lib/scope";

import { revalidatePath } from "next/cache";
import { db, today, writeTx } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { isRealIsoDate, zonedWallTimeToUtc } from "@/lib/date";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  getActiveSituations,
  setActiveSituations,
  resolveSituationId,
  deleteProfileSetting,
  getSituations,
  getTimezone,
  setSituationIllnessType,
} from "@/lib/settings";
import { generateAndStoreSuggestions } from "@/lib/supplement-suggest";
import {
  decrementSupply,
  incrementSupply,
  ensureMedicationCourse,
  setMedicationEndDate,
  setCourseStartDate,
  isLinkableSupply,
  deleteAdministrationLog,
  // The ONE intake_item_logs resolution core (#2039) — this action module holds no
  // dose-ledger SQL of its own.
  setDoseStatusCore,
  // The dose-schedule lifecycle core (#2131) — this action module holds no
  // retire/version SQL of its own.
  recordScheduleVersion,
  retireRemovedDoses,
  unretireDose,
  // The historical-dose cores keep the shared, kind-neutral names; the aliases only
  // keep them apart from the Server Actions of the same name defined below.
  logHistoricalDose as logHistoricalDoseCore,
  updateHistoricalDose as updateHistoricalDoseCore,
} from "@/lib/queries";
import {
  setIntakeActive,
  INTAKE_ACTIVE_REFUSAL_TEXT,
} from "@/lib/intake-active-write";
import { readForUpdate, casUpdate } from "@/lib/tx";
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
  OBLIGATIONS,
  FOOD_TIMINGS,
  parseDosage,
  spreadDoseTimes,
  collapsePrnDoses,
} from "@/lib/supplement-schedule";
import {
  CADENCE_KINDS,
  doseScheduleDiffers,
  normalizeWeekdays,
  type CadenceKind,
  type DoseSchedule,
} from "@/lib/intake-cadence";
import { getDoseScheduleVersions } from "@/lib/queries";
import {
  formError,
  formOk,
  type DoseStatusOutcome,
  type DoseStatusTarget,
  type FormResult,
} from "@/lib/types";
import type { HistoricalDoseOutcome } from "@/lib/types";
import { historicalDoseErrorMessage } from "@/lib/historical-dose-error";
import type {
  FoodTiming,
  PairRelation,
  SupplementCondition,
  SupplementKind,
  IntakeObligation,
} from "@/lib/types";
import { strOrNull } from "@/lib/parse";
import { demoteIntakeObligation } from "@/lib/intake-obligation-write";
import {
  DEMOTION_PREFIX,
  DEMOTION_OUTCOME_TEXT,
  demotionItemIdFromKey,
} from "@/lib/supplement-demotion";
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
  // The item's KIND is read before its obligation because the med guardrail depends
  // on it (see below): kind is clinical identity, and a medication's default is the
  // one obligation that carries a safety net.
  const kindEarly: SupplementKind =
    formData.get("kind") === "medication" ? "medication" : "supplement";
  const obligationRaw = String(
    formData.get("obligation") ??
      (kindEarly === "medication" ? "must" : "should")
  );
  // A `may` item is PRN-shaped by construction (#1505 collapsed obligation into it), so
  // the old separate as-needed checkbox is gone: choosing May IS choosing as-needed.
  const obligation: IntakeObligation = OBLIGATIONS.includes(
    obligationRaw as IntakeObligation
  )
    ? (obligationRaw as IntakeObligation)
    : kindEarly === "medication"
      ? "must"
      : "should";
  // CALENDAR cadence (#1602) — orthogonal to `condition` above and to `obligation`.
  // Each branch keeps ONLY its own fields so a user who tries weekly, picks days, then
  // switches back to daily doesn't leave a stale weekday list that would silently
  // re-narrow the schedule if the kind were ever changed back by another path.
  const cadenceKindRaw = String(formData.get("cadence_kind") ?? "daily");
  const cadenceKind: CadenceKind = CADENCE_KINDS.includes(
    cadenceKindRaw as CadenceKind
  )
    ? (cadenceKindRaw as CadenceKind)
    : "daily";
  const cadenceWeekdays =
    cadenceKind === "weekly"
      ? normalizeWeekdays(
          String(formData.get("cadence_weekdays") ?? "")
            .split(",")
            .map((x) => Number(x.trim()))
            .filter((n) => Number.isInteger(n))
        )
      : null;
  const cadenceIntervalRaw = Number(formData.get("cadence_interval_days"));
  const cadenceIntervalDays =
    cadenceKind === "interval" &&
    Number.isInteger(cadenceIntervalRaw) &&
    cadenceIntervalRaw >= 1
      ? cadenceIntervalRaw
      : null;
  const anchorRaw = String(formData.get("cadence_anchor_date") ?? "").trim();
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
  // Medication identity (CLINICAL, #1505): kind = 'medication' reveals the
  // prescriber/pharmacy/Rx fields; the medication-only columns are cleared for a
  // plain supplement so a kind flip can't leave stale data. Kind no longer decides
  // pushability — obligation does.
  const kind: SupplementKind = kindEarly;
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
  // PRN shape follows the obligation, not a second flag (#1505): `may` IS as-needed.
  // Unlike the old checkbox this is not medication-only — a `may` supplement
  // (magnesium, a preworkout) has exactly the same amount-only, take-when-you-want
  // shape, and pretending otherwise is what made "low priority" incoherent.
  const isPrn = obligation === "may";
  // PRN redose notice (issue #798). Only a PRN medication carries these; a non-PRN
  // item clears them so a kind/PRN flip can't leave a stale notice armed. The
  // interval/max are the user-CONFIRMED label numbers (pre-filled from
  // lib/prn-defaults but only ever the user's own number); a blank field stays NULL →
  // NO notice, ever (the liability line). redose_notice is the per-item opt-in, forced
  // OFF unless BOTH numbers are confirmed (an opt-in with nothing confirmed can never
  // fire, so it isn't stored as "on").
  const intervalRaw = Number(formData.get("min_interval_hours"));
  const minIntervalHours =
    isPrn && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : null;
  const maxRaw = Number(formData.get("max_daily_count"));
  const maxDailyCount =
    isPrn && Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : null;
  // Amount-aware daily maximum in mg (#1854), same confirm discipline: a PRN
  // item only, user-entered, blank/invalid stays NULL — the mg basis is then
  // simply unavailable and the counters fall back to counting doses. It does NOT
  // gate the redose opt-in (interval + count max remain that pair).
  const maxMgRaw = Number(formData.get("max_daily_amount_mg"));
  const maxDailyAmountMg =
    isPrn && Number.isFinite(maxMgRaw) && maxMgRaw > 0 ? maxMgRaw : null;
  const redoseNotice =
    isPrn &&
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
    cadenceKind,
    cadenceWeekdays,
    cadenceIntervalDays,
    cadenceAnchorDate,
    notes: str("notes"),
    brand: str("brand"),
    product: str("product"),
    stack: str("stack"),
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
    isPrn,
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
  // Per-row calendar (#1602), already normalized by parseDoses: a canonical weekday
  // CSV (or null) and an inclusive validity window.
  weekdays: string | null;
  start_date: string | null;
  end_date: string | null;
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
    // Per-row calendar (#1602). normalizeWeekdays drops anything out of range and
    // canonicalizes the order, so an equivalent re-submission stores identically and a
    // no-op edit never looks like a change. A malformed date is dropped to null rather
    // than stored — an unparseable window would read as "no window", and storing it
    // would leave a value that looks like a rule but constrains nothing.
    weekdays: normalizeWeekdays(
      Array.isArray(d?.weekdays)
        ? d.weekdays.map((x: unknown) => Number(x))
        : []
    ),
    start_date: isRealIsoDate(d?.start_date) ? d.start_date : null,
    end_date: isRealIsoDate(d?.end_date) ? d.end_date : null,
  }));
  return out.length
    ? out
    : [
        {
          amount: null,
          time_of_day: null,
          food_timing: "any",
          weekdays: null,
          start_date: null,
          end_date: null,
        },
      ];
}

// Stamp created_at so the adherence-pattern window starts at the dose's real birth,
// not the parent item's (#430). SQLite forbids datetime('now') as an ADD COLUMN
// default, so the write path sets it explicitly — from the CLOCK SEAM (sqlNow,
// #1534), because doseAdherenceSince truncates this stamp to a calendar DAY
// (`.slice(0, 10)`) and compares it against a `today()`-derived window.
const insertDoseStmt = () =>
  db.prepare(
    `INSERT INTO intake_item_doses
       (item_id, amount, time_of_day, food_timing, sort, created_at,
        weekdays, start_date, end_date)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

// The schedule-version writer (recordScheduleVersion) lives with the dose-lifecycle
// core (#2131, lib/queries/intake/dose-lifecycle.ts) so the dose-edit path and the
// retire/un-retire transitions share ONE version writer; imported above.

// Insert a fresh set of doses for a supplement (used on add + accept). Must run
// inside a transaction.
function insertDoses(
  suppId: number,
  doses: {
    amount: string | null;
    time_of_day: string | null;
    food_timing: FoodTiming;
    // Optional so the AI-suggestion accept path — which has no calendar to offer —
    // still type-checks and simply inserts an unrestricted row (#1602).
    weekdays?: string | null;
    start_date?: string | null;
    end_date?: string | null;
  }[],
  // The profile-LOCAL calendar day the doses are born on — the first version's
  // `effective_from` (#1973). Local rather than a UTC slice of `created_at` because it is
  // compared against the profile-local windows every adherence surface is built from.
  birthDay: string
) {
  const ins = insertDoseStmt();
  doses.forEach((d, i) => {
    const info = ins.run(
      suppId,
      d.amount,
      d.time_of_day,
      d.food_timing,
      i,
      sqlNow(),
      d.weekdays ?? null,
      d.start_date ?? null,
      d.end_date ?? null
    );
    // Seed the schedule history at birth (#1973). Without this first version, the FIRST
    // edit would have nothing to close: the new version would become the earliest one,
    // and the resolver's before-recorded-history fallback would judge every past day by
    // the NEW rule — the retroactive re-judgment this whole feature exists to prevent.
    recordScheduleVersion(Number(info.lastInsertRowid), birthDay, d);
  });
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
  // Created FROM a shared bottle (#1705): the item form's picker posts the bottle it was
  // seeded from, so "there's a shared bottle of D3 5000 IU; add it for my daughter" is
  // ONE step instead of create-then-find-the-link-control. Validated against the SAME
  // offerability rule the picker used (isLinkableSupply over the caller's own scope), so
  // a forged id can't attach this item to a household branch the caller can't reach — and
  // a linked item keeps NO private count (the phantom-double-supply invariant), which is
  // why quantity_on_hand is forced NULL below rather than trusted from the form.
  const postedSupplyId = Number(formData.get("supply_id") ?? 0);
  let supplyId: number | null = null;
  if (postedSupplyId) {
    const scope = await requireScope();
    if (!isLinkableSupply(scope.ids, postedSupplyId))
      return formError("Couldn't find that shared bottle.");
    supplyId = postedSupplyId;
  }
  const todayStr = today(profile.id);
  const hasStartedOn = formData.has("started_on");
  const startedOnRaw = String(formData.get("started_on") ?? "").trim();
  if (
    f.kind === "medication" &&
    hasStartedOn &&
    ((!f.isPrn && !startedOnRaw) ||
      (!!startedOnRaw &&
        (!isRealIsoDate(startedOnRaw) || startedOnRaw > todayStr)))
  ) {
    return formError(
      f.isPrn
        ? "Enter a valid start date that isn't in the future."
        : "Enter a start date that isn't in the future."
    );
  }
  const doses = collapsePrnDoses(parseDoses(formData), f.isPrn);
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
    // created_at is bound from the CLOCK SEAM (sqlNow, #1534) rather than left to the
    // column's `datetime('now')` default: an intake item's created_at is read as a
    // calendar DAY — `date(created_at)` seeds a medication course's started_on and
    // decides episode membership (getEpisodeMedReconciliation), and
    // doseAdherenceSince truncates it — all against `today()`-derived windows.
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, obligation, brand, product, situation, situation_id,
            pause_situation_id, stack,
            critical, escalate_after_min, escalate_chat_id,
            quantity_on_hand, qty_per_dose,
            kind, prescriber, pharmacy, rx_number, rx,
            min_interval_hours, max_daily_count, max_daily_amount_mg, redose_notice,
            rxcui, rxcui_ingredients, provider_id, indication_condition_id, source, profile_id,
            created_at,
            cadence_kind, cadence_weekdays, cadence_interval_days, cadence_anchor_date,
            supply_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual',?,?,?,?,?,?,?)`
      )
      .run(
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
        supplyId != null ? null : f.quantityOnHand,
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
        profile.id,
        sqlNow(),
        f.cadenceKind,
        f.cadenceWeekdays,
        f.cadenceIntervalDays,
        f.cadenceAnchorDate,
        supplyId
      );
    const suppId = Number(info.lastInsertRowid);
    insertDoses(suppId, doses, todayStr);
    reconcilePairs(suppId, pairs, profile.id);
    // Ensure-course-on-create: a new medication opens an initial course
    // on the chosen date (today for quick-add). A no-op for supplements (kind
    // guard inside the helper).
    if (f.kind === "medication") {
      ensureMedicationCourse(
        profile.id,
        suppId,
        hasStartedOn ? startedOnRaw || null : f.isPrn ? null : todayStr,
        f.isPrn && (!hasStartedOn || !startedOnRaw)
      );
    }
  });
  // A newly pooled item changes what the cabinet and its doors show.
  if (supplyId != null) revalidatePath("/supplies");
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
    ((!f.isPrn && !startedOnRaw) ||
      (!!startedOnRaw &&
        (!isRealIsoDate(startedOnRaw) || startedOnRaw > todayStr)))
  ) {
    return formError(
      f.isPrn
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
  const doses = collapsePrnDoses(parseDoses(formData), f.isPrn);
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
  const result = writeTx((tx) => {
    // Verify ownership before touching the supplement or its child rows — the
    // form id is untrusted. Bail (no-op) when it isn't owned. Also snapshot the
    // prior refill-tracked state (active + quantity_on_hand) so an edit that turns
    // quantity tracking off can clear the low-supply episode marker (issue #325).
    const owned = db
      .prepare(
        "SELECT active, quantity_on_hand, created_at FROM intake_items WHERE id = ? AND profile_id = ?"
      )
      .get(id, profile.id) as
      | {
          active: number;
          quantity_on_hand: number | null;
          created_at: string | null;
        }
      | undefined;
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
         SET name = ?, notes = ?, condition = ?, obligation = ?, brand = ?,
             product = ?, situation = ?, situation_id = ?, pause_situation_id = ?,
             stack = ?,
             critical = ?, escalate_after_min = ?, escalate_chat_id = ?,
             quantity_on_hand = ?, qty_per_dose = ?,
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
      effectiveQuantityOnHand,
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
    const ins = insertDoseStmt();
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
            `SELECT d.id, d.created_at, d.time_of_day, d.weekdays,
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
        // Effective-date the change (#1973). A dueness-relevant edit APPENDS a version
        // effective today; every earlier day keeps resolving to the rule that was in
        // force then, so the history is neither rewritten nor thrown away. A cosmetic
        // edit (amount, food timing, sort) cannot reach `doseScheduleDiffers` and
        // therefore cannot move an adherence boundary at all.
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
            recordScheduleVersion(d.id, born, prior);
          }
          recordScheduleVersion(d.id, todayStr, d);
        }
      } else {
        const info = ins.run(
          id,
          d.amount,
          d.time_of_day,
          d.food_timing,
          i,
          sqlNow(),
          d.weekdays ?? null,
          d.start_date ?? null,
          d.end_date ?? null
        );
        const newId = Number(info.lastInsertRowid);
        // A dose added by an edit is born today; seed its first version so its own
        // first schedule change has something to close (#1973).
        recordScheduleVersion(newId, todayStr, d);
        keptIds.push(newId);
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
    // Ensure-course invariant: if this row is (or just became) a
    // medication, make sure it has at least one course. No-op when it already has
    // one or is a supplement. Uses the created_at-date fallback (no explicit start
    // date on an edit).
    if (f.kind === "medication") {
      ensureMedicationCourse(
        profile.id,
        id,
        hasStartedOn ? startedOnRaw || null : null,
        !!f.isPrn && hasStartedOn && !startedOnRaw
      );
      if (hasStartedOn && hasCourseId) {
        // Through the course core (#2132) inside THIS transaction (the Tx token) — the
        // course was validated above, so a refusal here is unreachable.
        setCourseStartDate(tx, profile.id, id, courseId, startedOnRaw || null);
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

// What the web tri-state check-off says per setDoseStatusCore outcome (#2039).
//
// Until the two dose-resolution cores were unified this action returned formOk()
// unconditionally, which is precisely the thing the repo's write rules forbid: the write
// can legitimately refuse (a forged/stale dose id, a paused item) and a silent "ok" tells
// the control the dose is resolved when nothing was written. Every reachable tap still
// answers ok — the control is only rendered for an active, non-retired dose — so this
// changes what a FORGED post is told, not what a real one sees.
function doseStatusResult(outcome: DoseStatusOutcome): FormResult {
  switch (outcome) {
    case "stale-dose":
      return formError("That dose is no longer scheduled.");
    case "inactive":
      return formError("That item is paused.");
    default:
      return formOk();
  }
}

// Set a single dose's status for today to an explicit target — the web
// tri-state's write path (taken / skipped / clear). #232
//
// Cross-profile (#858/#1373): a multi-view Medications board confirms a household
// member's scheduled dose without switching the acting profile — the board posts an
// explicit `profileId`, and the write gates on the TARGET via requireProfileWriteAccess
// (the #31 cross-profile gate) instead of the active-profile requireWriteAccess. Absent
// (the acting board / single-view / Supplements row), the active profile is used, so
// those callers are byte-identical. setDoseStatusCore scopes the dose to that profile,
// so a dose the target doesn't own writes nothing and answers "stale-dose".
//
// This is a thin authorization + validation boundary (#2039): the ledger transition, its
// refusals and every supply movement belong to the auth-blind core in
// lib/queries/intake/adherence.ts, which the Telegram, offline and household paths use
// too.
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
  const outcome = setDoseStatusCore(
    profileId,
    doseId,
    today(profileId),
    target
  );
  revalidateIntake();
  return doseStatusResult(outcome);
}

// ── Historical dose correction (#1933) ──────────────────────────────────────────
// Backfill / amend / remove one recorded administration. These live HERE, in the
// kind-agnostic intake action module, because the cores they wrap are shared
// machinery: /medications and /nutrition?tab=supplements render the same dose-history
// panel over the same ungated cores, and an action module named for one of the two
// surfaces would be the split all over again. Each is a thin auth + parse boundary:
// the auth-blind cores own ownership scoping, course/date rules, duplicate semantics,
// the amount snapshot, and every supply movement.
//
// All three are AUDITED. A dose confirmed by tapping today's check-off is ordinary
// use; retroactively rewriting what the record says was given is clinically
// significant — especially where a caregiver amends a dose somebody else gave — so it
// earns an audit row through the repo's one audit mechanism (recordAudit), carrying
// identifiers and the affected date only.

// Deliberately backfill one past dose from a dose-history panel. The profile-local
// wall time is converted here; the core owns everything else, including the optional
// supply adjustment (pool-aware for a shared bottle, #1374).
export async function logHistoricalDose(
  formData: FormData
): Promise<FormResult> {
  const { login, profile } = await requireWriteAccess();
  const itemId = Number(formData.get("id"));
  const doseId = Number(formData.get("dose_id"));
  const date = String(formData.get("date") ?? "");
  const time = String(formData.get("time") ?? "");
  if (
    !itemId ||
    !doseId ||
    !isRealIsoDate(date) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  ) {
    return formError("Enter a valid dose date and time.");
  }

  const givenAt = zonedWallTimeToUtc(getTimezone(profile.id), date, time);
  if (!givenAt) return formError("Enter a valid dose date and time.");

  const outcome = logHistoricalDoseCore(
    profile.id,
    itemId,
    doseId,
    givenAt,
    strOrNull(formData.get("amount")),
    formData.get("adjust_supply") === "1"
  );
  if (outcome.kind === "logged") {
    recordAudit({
      loginId: login.id,
      profileId: profile.id,
      action: AUDIT_ACTIONS.doseLogBackfill,
      target: String(itemId),
      detail: outcome.date,
    });
    revalidateIntake();
    revalidatePath(`/medications/${itemId}`);
    return formOk();
  }
  return historicalDoseError(outcome);
}

// Correct an existing history row (time / amount) without changing its original supply
// effect. The core owns row scoping, course correction, and scheduled/PRN uniqueness.
//
// AN EMPTY `time` IS A REAL ANSWER here (#2228 decisions 1–3), unlike on the backfill
// above: the amendment writes the stated event instant (`occurred_at`) and null means
// "no intake time stated", so amending only the amount of a dose whose intake time
// was never stated changes the amount and nothing else. The submitted `date` is the
// row's day in its own right — the core refuses a stated instant that disagrees with
// it rather than re-dating the row.
export async function updateHistoricalDose(
  formData: FormData
): Promise<FormResult> {
  const { login, profile } = await requireWriteAccess();
  const itemId = Number(formData.get("id"));
  const logId = Number(formData.get("log_id"));
  const date = String(formData.get("date") ?? "");
  const time = String(formData.get("time") ?? "");
  if (
    !itemId ||
    !logId ||
    !isRealIsoDate(date) ||
    (time !== "" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
  ) {
    return formError("Enter a valid dose date and time.");
  }

  let occurredAt: Date | null = null;
  if (time !== "") {
    occurredAt = zonedWallTimeToUtc(getTimezone(profile.id), date, time);
    if (!occurredAt) return formError("Enter a valid dose date and time.");
  }

  const outcome = updateHistoricalDoseCore(
    profile.id,
    itemId,
    logId,
    date,
    occurredAt,
    strOrNull(formData.get("amount"))
  );
  if (outcome.kind === "logged") {
    recordAudit({
      loginId: login.id,
      profileId: profile.id,
      action: AUDIT_ACTIONS.doseLogAmend,
      target: String(itemId),
      detail: outcome.date,
    });
    revalidateIntake();
    revalidatePath(`/medications/${itemId}`);
    return formOk();
  }
  return historicalDoseError(outcome);
}

// The one refusal→message mapping lives in lib/historical-dose-error.ts now (#2228
// decision 6): the illness-episode amendment renders the same core's outcomes, and a
// "use server" module may export only actions, so the shared mapping cannot live here.
function historicalDoseError(
  outcome: Exclude<HistoricalDoseOutcome, { kind: "logged" }>
): FormResult {
  return formError(historicalDoseErrorMessage(outcome));
}

// Remove one recorded administration with undo (#851 item 11). A mis-tapped confirm
// otherwise permanently decrements supply, advances the PRN redose window, and counts
// toward the daily max — so the removal (and its Undo) inverts all three (supply
// directly, the window/count via the ledger row being gone). Returns the { undoId } the
// shared useUndoableDelete toast wires to undoDelete → restoreAdministrationLog.
export async function deleteAdministration(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { login, profile } = await requireWriteAccess();
  const logId = Number(formData.get("log_id"));
  if (!logId) return { undoId: null };
  const removed = deleteAdministrationLog(profile.id, logId);
  if (removed) {
    recordAudit({
      loginId: login.id,
      profileId: profile.id,
      action: AUDIT_ACTIONS.doseLogDelete,
      target: String(removed.itemId),
      detail: removed.date,
    });
    revalidatePath(`/medications/${removed.itemId}`);
  }
  revalidateIntake();
  return { undoId: removed?.undoId ?? null };
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
  const outcome = setDoseStatusCore(
    profile.id,
    doseId,
    date,
    existing?.status === "taken" ? "clear" : "taken"
  );
  revalidateIntake();
  return doseStatusResult(outcome);
}

export type SetItemActiveResult =
  { ok: true; state: "paused" | "resumed" } | { ok: false; error: string };

// Pause or resume an intake item (#2133). STATE-NAMED, not a toggle: the form posts the
// state its render promised (`to`), the auth-blind core (lib/intake-active-write.ts)
// compare-and-swaps it inside one IMMEDIATE transaction, and a stale tab's "Pause" on
// an already-paused item refuses with a typed outcome the row renders — never the old
// read-then-flip that RESUMED it while toasting "paused". The success words come from
// the outcome, not the stale render. A medication's course history moves in the same
// transition (the active=1 ⇔ open-course invariant, via the #2132 course core).
export async function setItemActive(
  formData: FormData
): Promise<SetItemActiveResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const toRaw = String(formData.get("to") ?? "");
  if (!id || (toRaw !== "0" && toRaw !== "1")) {
    return formError("Couldn't find that item.");
  }
  const to: 0 | 1 = toRaw === "1" ? 1 : 0;
  // The refill-tracked input for the #325 marker drop below; the transition itself is
  // decided by the core, never by this read.
  const row = db
    .prepare(
      "SELECT quantity_on_hand FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as { quantity_on_hand: number | null } | undefined;
  const outcome = setIntakeActive(profile.id, id, to);
  if (outcome !== "paused" && outcome !== "resumed") {
    return formError(INTAKE_ACTIVE_REFUSAL_TEXT[outcome]);
  }
  // Pausing a tracked item removes it from the refill-nudge tracked set; drop its
  // low-supply episode marker so resuming it while still low re-fires a fresh nudge
  // (issue #325). No-op on resume (the transition fired means prior state was active),
  // or when the item wasn't refill-tracked.
  if (
    outcome === "paused" &&
    row &&
    leftRefillTrackedSet(
      { active: true, quantityOnHand: row.quantity_on_hand },
      { active: false, quantityOnHand: row.quantity_on_hand }
    )
  ) {
    deleteProfileSetting(profile.id, refillMarkerKey(id));
  }
  revalidateIntake();
  return { ok: true, state: outcome };
}

// Restore a retired dose to the schedule (#2131) — the un-retire the retire never had.
// Thin boundary: auth here, the guarded transition (retired? conflicting live slot?)
// in the dose-lifecycle core, whose typed outcome is rendered verbatim — never an
// unconditional confirm. Success returns the restored dose so the open edit form can
// show the row (and keep it across its own save) without a refetch.
export type RestoreDoseResult =
  | {
      ok: true;
      dose: {
        id: number;
        amount: string | null;
        time_of_day: string | null;
        food_timing: FoodTiming;
        weekdays: string | null;
        start_date: string | null;
        end_date: string | null;
      };
    }
  | { ok: false; error: string };

export async function restoreDose(
  formData: FormData
): Promise<RestoreDoseResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return formError("Couldn't find that dose.");
  const outcome = unretireDose(profile.id, doseId);
  switch (outcome.kind) {
    case "restored": {
      revalidateIntake();
      const { item_id: _itemId, ...dose } = outcome.dose;
      return { ok: true, dose };
    }
    case "schedule-conflict":
      return formError(
        "A live dose already covers that time slot — edit it instead of restoring this one."
      );
    case "not-retired":
      return formError("That dose is already on the schedule.");
    case "not-found":
    default:
      return formError("Couldn't find that dose.");
  }
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
  // The WHOLE accept — the pending check, the claim, and the item + dose inserts — runs
  // inside ONE IMMEDIATE transaction (#2139). The claim is a compare-and-swap on
  // status='pending' via the Tx-token helpers, so two concurrent accepts (a double-tap
  // across a slow response, two devices) produce exactly one medication and one honest
  // refusal — the old guard was a plain read before the transaction, and both racers
  // passed it.
  const accepted = writeTx((tx): boolean => {
    const s = readForUpdate<{
      status: string;
      name: string;
      dosage: string | null;
      time_of_day: string | null;
      food_timing: FoodTiming;
      condition: string;
      obligation: string;
      brand: string | null;
      product: string | null;
      situation: string | null;
      rationale: string;
    }>(
      tx,
      db.prepare(
        "SELECT * FROM intake_item_suggestions WHERE id = ? AND profile_id = ?"
      ),
      id,
      profile.id
    );
    if (!s || s.status !== "pending") return false;
    // Claim the suggestion FIRST: the expectation lives in the WHERE, and only the
    // accept whose UPDATE lands may mint the item.
    const claim = casUpdate(
      tx,
      db.prepare(
        "UPDATE intake_item_suggestions SET status = 'accepted' WHERE id = ? AND profile_id = ? AND status = 'pending'"
      ),
      id,
      profile.id
    );
    if (claim.kind === "stale") return false;
    // Parse the free-text dosage ("5–10 g once daily") into a clean amount and
    // intake count, rather than dumping it all into one dose's amount.
    const parsed = parseDosage(s.dosage);
    const amount = parsed.amount ?? s.dosage;
    const time = s.time_of_day ?? parsed.timeOfDay ?? null;
    const times = spreadDoseTimes(parsed.perDay, time);
    // Link an accepted situational suggestion to its situation ROW (#560).
    const situationId =
      s.condition === "situational" && s.situation
        ? resolveSituationId(profile.id, s.situation)
        : null;
    // created_at is bound from the CLOCK SEAM (sqlNow, #1534) rather than left to the
    // column's `datetime('now')` default: an intake item's created_at is read as a
    // calendar DAY — `date(created_at)` seeds a medication course's started_on and
    // decides episode membership (getEpisodeMedReconciliation), and
    // doseAdherenceSince truncates it — all against `today()`-derived windows.
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, obligation, brand, product, situation, situation_id, stack, source, profile_id,
            created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'manual',?,?)`
      )
      .run(
        s.name,
        s.rationale,
        s.condition,
        s.obligation,
        s.brand,
        s.product,
        s.situation,
        situationId,
        null,
        profile.id,
        sqlNow()
      );
    const suppId = Number(info.lastInsertRowid);
    insertDoses(
      suppId,
      times.map((t) => ({
        amount,
        time_of_day: t,
        food_timing: s.food_timing ?? "any",
      })),
      today(profile.id)
    );
    return true;
  });
  if (!accepted) return formError("That suggestion is no longer available.");
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
// from the item form's standardized-ingredient affordance; the user CONFIRMS a candidate,
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

// Accept a priority DEMOTION SUGGESTION (issue #1505 part 2): re-tag a high/mandatory
// supplement the user has effectively stopped taking as `low` — tracked, never pushed.
//
// THIS TAP IS THE PRIORITY WRITE. The detector only ever suggests; nothing in the
// system demotes on its own (#559 — priority is the user's declaration). The write
// core is auth-blind and returns a typed outcome, which is surfaced verbatim rather
// than confirmed unconditionally: accepting a stale card for a paused or already-low
// item legitimately refuses, and the caller must say so (the inline-action rule).
//
// The suggestion's finding is also dismissed on success, so the accepted card leaves
// the page immediately rather than lingering until the next detection window closes.
export async function acceptDemotionSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  // Namespace guard, exactly like every other finding action: this action can only
  // ever act on a demotion-suggestion key. The item id is DERIVED from that one key
  // rather than posted alongside it, so an accept can never target an item its own
  // suggestion wasn't about.
  const itemId = demotionItemIdFromKey(dedupeKey);
  if (itemId == null) return formError("Couldn't update that item.");

  const outcome = demoteIntakeObligation(profile.id, itemId);
  if (outcome !== "demoted") return formError(DEMOTION_OUTCOME_TEXT[outcome]);
  dismissFinding(profile.id, dedupeKey);
  revalidatePath("/nutrition");
  revalidatePath("/upcoming");
  revalidatePath("/");
  return formOk();
}

// Dismiss a priority DEMOTION SUGGESTION without acting on it — the calm half of the
// coaching-tier contract. Hides it through the shared findings-bus suppression store,
// guarded to the demotion namespace; profile-scoped via dismissFinding.
export async function dismissDemotionSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!dedupeKey.startsWith(DEMOTION_PREFIX))
    return formError("Couldn't dismiss that suggestion.");
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
