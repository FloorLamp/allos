"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  getActiveSituations,
  setActiveSituations,
  deleteProfileSetting,
} from "@/lib/settings";
import { generateAndStoreSuggestions } from "@/lib/supplement-suggest";
import {
  decrementSupply,
  incrementSupply,
  ensureMedicationCourse,
  setMedicationActive,
  stopMedicationCourses,
  restartMedicationCourse,
  insertMedicationSideEffect,
  updateMedicationSideEffect,
  toggleMedicationSideEffectResolved,
  deleteMedicationSideEffect,
  promoteMedicationSideEffect,
} from "@/lib/queries";
import {
  normalizeStopReason,
  normalizeSeverity,
} from "@/lib/medication-history";
import { resolveProviderIdByName } from "@/lib/providers-db";
import { lookupRxNormCandidates } from "@/lib/rxnorm";
import { orderIntakePair } from "@/lib/intake-pairs";
import { withAiLogContext } from "@/lib/ai-log";
import {
  CONDITIONS,
  PRIORITIES,
  FOOD_TIMINGS,
  parseDosage,
  spreadDoseTimes,
} from "@/lib/supplement-schedule";
import type {
  FoodTiming,
  PairRelation,
  SupplementCondition,
  SupplementKind,
  SupplementPriority,
} from "@/lib/types";
import { strOrNull } from "@/lib/parse";
import { isRealIsoDate } from "@/lib/date";

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
  const qtyRaw = String(formData.get("quantity_on_hand") ?? "").trim();
  const quantityOnHand =
    qtyRaw === "" || !Number.isFinite(Number(qtyRaw))
      ? null
      : Math.max(0, Number(qtyRaw));
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
  const asNeeded =
    isMed &&
    (formData.get("as_needed") === "1" || formData.get("as_needed") === "on")
      ? 1
      : 0;
  // Cached RxNorm concept id (issue #144) — user-confirmed on the form; kept for both
  // kinds since supplement-drug interactions are a first-class case here.
  const rxcui = str("rxcui");
  return {
    notes: str("notes"),
    brand: str("brand"),
    product: str("product"),
    stack: str("stack"),
    condition,
    priority,
    situation,
    critical: critical ? 1 : 0,
    escalateAfterMin,
    escalateChatId,
    quantityOnHand,
    qtyPerDose,
    kind,
    prescriber,
    pharmacy,
    rxNumber,
    asNeeded,
    rxcui,
  };
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

const insertDoseStmt = () =>
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?,?,?,?,?)`
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

export async function addSupplement(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const f = fields(formData);
  const doses = parseDoses(formData);
  const pairs = parsePairs(formData);
  // Prescribing provider: medications only, resolved into the shared
  // GLOBAL registry (create-on-type); NULL for supplements.
  const providerId =
    f.kind === "medication"
      ? resolveProviderIdByName(String(formData.get("provider") ?? ""))
      : null;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, priority, brand, product, situation, stack,
            critical, escalate_after_min, escalate_chat_id,
            quantity_on_hand, qty_per_dose,
            kind, prescriber, pharmacy, rx_number, as_needed, rxcui, provider_id, source, profile_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'manual',?)`
      )
      .run(
        name,
        f.notes,
        f.condition,
        f.priority,
        f.brand,
        f.product,
        f.situation,
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
        f.asNeeded,
        f.rxcui,
        providerId,
        profile.id
      );
    const suppId = Number(info.lastInsertRowid);
    insertDoses(suppId, doses);
    reconcilePairs(suppId, pairs, profile.id);
    // Ensure-course-on-create: a new medication opens an initial course
    // dated today. A no-op for supplements (kind guard inside the helper).
    if (f.kind === "medication") {
      ensureMedicationCourse(profile.id, suppId, today(profile.id));
    }
  });
  tx();
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function updateSupplement(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const f = fields(formData);
  const doses = parseDoses(formData);
  const pairs = parsePairs(formData);
  // Prescribing provider: medications only; NULL for supplements so
  // a kind flip back to supplement clears a stale link.
  const providerId =
    f.kind === "medication"
      ? resolveProviderIdByName(String(formData.get("provider") ?? ""))
      : null;
  const tx = db.transaction(() => {
    // Verify ownership before touching the supplement or its child rows — the
    // form id is untrusted. Bail (no-op) when it isn't owned.
    const owned = db
      .prepare("SELECT 1 FROM intake_items WHERE id = ? AND profile_id = ?")
      .get(id, profile.id);
    if (!owned) return;
    db.prepare(
      `UPDATE intake_items
         SET name = ?, notes = ?, condition = ?, priority = ?, brand = ?,
             product = ?, situation = ?, stack = ?,
             critical = ?, escalate_after_min = ?, escalate_chat_id = ?,
             quantity_on_hand = ?, qty_per_dose = ?,
             kind = ?, prescriber = ?, pharmacy = ?, rx_number = ?, as_needed = ?,
             rxcui = ?, provider_id = ?
       WHERE id = ? AND profile_id = ?`
    ).run(
      name,
      f.notes,
      f.condition,
      f.priority,
      f.brand,
      f.product,
      f.situation,
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
      f.asNeeded,
      f.rxcui,
      providerId,
      id,
      profile.id
    );
    // Reconcile doses: update those with an id, insert new ones, and remove the
    // rest from the schedule. Updating in place (rather than delete-all +
    // re-insert) preserves the adherence logs keyed on dose_id AND keeps any
    // in-flight Telegram reminder buttons (which carry the dose id) valid across
    // a brand/dosage edit. The retired = 0 guard keeps a forged/stale id from
    // rewriting a retired dose's row, which history still displays through.
    const ins = insertDoseStmt();
    const upd = db.prepare(
      `UPDATE intake_item_doses SET amount = ?, time_of_day = ?, food_timing = ?, sort = ?
       WHERE id = ? AND item_id = ? AND retired = 0`
    );
    const keptIds: number[] = [];
    doses.forEach((d, i) => {
      if (d.id) {
        upd.run(d.amount, d.time_of_day, d.food_timing, i, d.id, id);
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
      ensureMedicationCourse(profile.id, id, null);
    }
  });
  tx();
  revalidatePath("/medicine");
  revalidatePath("/");
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
  } else if (!existing) {
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status) VALUES (?,?,?,?,?)"
    ).run(
      doseId,
      dose.item_id,
      date,
      target === "taken" ? dose.amount : null,
      target
    );
  } else {
    db.prepare(
      "UPDATE intake_item_logs SET status = ?, amount = ? WHERE dose_id = ? AND date = ?"
    ).run(target, target === "taken" ? dose.amount : null, doseId, date);
  }

  if (current !== "taken" && target === "taken") {
    decrementSupply(profileId, dose.item_id);
  } else if (current === "taken" && target !== "taken") {
    incrementSupply(profileId, dose.item_id);
  }
}

// Set a single dose's status for today to an explicit target — the web
// tri-state's write path (taken / skipped / clear). #232
export async function setDoseStatus(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  const target = String(formData.get("status") ?? "");
  if (
    !doseId ||
    (target !== "taken" && target !== "skipped" && target !== "clear")
  ) {
    return;
  }
  applyDoseStatus(profile.id, doseId, today(profile.id), target);
  revalidatePath("/medicine");
  revalidatePath("/");
}

// Toggle a single dose's TAKEN log for today (taken ↔ clear). A skipped dose
// (issue #232) counts as "not taken", so this flips it to taken. Kept as the
// dedicated take toggle; setDoseStatus is the general tri-state path.
export async function toggleTaken(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return;
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
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function toggleActive(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const row = db
    .prepare(
      "SELECT active, kind FROM intake_items WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as { active: number; kind: string } | undefined;
  if (!row) return;
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
  revalidatePath("/medicine");
  revalidatePath("/");
}

// ---- Medication lifecycle: stop / restart / side effects ----
// Thin session wrappers over the profile-scoped lib/queries helpers, which own
// the transactions + ownership checks.

// Stop a medication: close its open course (reason + note) and clear `active`;
// optionally capture a side effect at stop time.
export async function stopMedication(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  stopMedicationCourses(profile.id, id, {
    date: today(profile.id),
    reason: normalizeStopReason(formData.get("stop_reason")),
    note: strOrNull(formData.get("note")),
    effect: strOrNull(formData.get("effect")),
    severity: normalizeSeverity(formData.get("severity")),
  });
  revalidatePath("/medicine");
  revalidatePath("/");
}

// Restart a medication: open a NEW course dated today and set `active` back on.
export async function restartMedication(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  restartMedicationCourse(profile.id, id, today(profile.id));
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function addSideEffect(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id")); // the medication (item) id
  const effect = strOrNull(formData.get("effect"));
  if (!id || !effect) return;
  const notedRaw = strOrNull(formData.get("noted_on"));
  const courseRaw = Number(formData.get("course_id"));
  insertMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : today(profile.id),
    notes: strOrNull(formData.get("notes")),
    courseId: courseRaw > 0 ? courseRaw : null,
  });
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function updateSideEffect(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const effect = strOrNull(formData.get("effect"));
  if (!id || !effect) return;
  const notedRaw = strOrNull(formData.get("noted_on"));
  updateMedicationSideEffect(profile.id, id, {
    effect,
    severity: normalizeSeverity(formData.get("severity")),
    notedOn: notedRaw && isRealIsoDate(notedRaw) ? notedRaw : null,
    notes: strOrNull(formData.get("notes")),
    resolved:
      formData.get("resolved") === "1" || formData.get("resolved") === "on"
        ? 1
        : 0,
  });
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function toggleSideEffectResolved(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  toggleMedicationSideEffectResolved(profile.id, id);
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function deleteSideEffect(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  deleteMedicationSideEffect(profile.id, id);
  revalidatePath("/medicine");
  revalidatePath("/");
}

// Promote a medication side effect into a manual allergies/intolerance row.
// The side effect is kept (marked resolved) for the medication's history.
export async function promoteSideEffectToIntolerance(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  promoteMedicationSideEffect(profile.id, id, today(profile.id));
  revalidatePath("/medicine");
  revalidatePath("/allergies");
  revalidatePath("/");
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
  const undoId = captureDelete("intake-item", profile.id, id);
  // Drop the item's low-supply episode marker with it (issue #203). This is a
  // dead row rather than wrong suppression — the id never recycles — but leaving
  // it strands a `notify_last_refill_<id>` setting the item no longer backs.
  deleteProfileSetting(profile.id, `notify_last_refill_${id}`);
  revalidatePath("/medicine");
  revalidatePath("/");
  return { undoId };
}

export async function toggleSituation(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const situation = String(formData.get("situation") ?? "").trim();
  if (!situation) return;
  const active = new Set(getActiveSituations(profile.id));
  if (active.has(situation)) active.delete(situation);
  else active.add(situation);
  setActiveSituations(profile.id, [...active]);
  revalidatePath("/medicine");
  revalidatePath("/");
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
  revalidatePath("/medicine");
  if (note) return { ok: false, message: note };
  return {
    ok: true,
    message:
      inserted > 0
        ? `Added ${inserted} suggestion${inserted === 1 ? "" : "s"}.`
        : "No new suggestions from your current data.",
  };
}

export async function acceptSuggestion(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
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
  if (!s) return;
  // Parse the free-text dosage ("5–10 g once daily") into a clean amount and
  // intake count, rather than dumping it all into one dose's amount.
  const parsed = parseDosage(s.dosage);
  const amount = parsed.amount ?? s.dosage;
  const time = s.time_of_day ?? parsed.timeOfDay ?? null;
  const times = spreadDoseTimes(parsed.perDay, time);
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO intake_items
           (name, notes, condition, priority, brand, product, situation, stack, source, profile_id)
         VALUES (?,?,?,?,?,?,?,?,'manual',?)`
      )
      .run(
        s.name,
        s.rationale,
        s.condition,
        s.priority,
        s.brand,
        s.product,
        s.situation,
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
  tx();
  revalidatePath("/medicine");
  revalidatePath("/");
}

export async function dismissSuggestion(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare(
    "UPDATE intake_item_suggestions SET status = 'dismissed' WHERE id = ? AND profile_id = ?"
  ).run(id, profile.id);
  revalidatePath("/medicine");
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
