"use server";
import {
  requireProfileWriteAccess,
  requireSession,
  requireWriteAccess,
} from "@/lib/auth";
import { newBundle } from "@/lib/bundle";
import {
  addIntakeItemCore,
  updateIntakeItemCore,
} from "@/lib/intake-item-write";
import {
  LOGGED_VIA_FIELD,
  parseWebOrigin,
  type StampedFormData,
} from "@/lib/logged-via";
import { requireScope } from "@/lib/scope";
import { gateItemProfile } from "../gate-item";
import { cabinetViewer, requirePoolWriteAccess } from "../supplies/access";

import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { isRealIsoDate, zonedWallTimeToUtc } from "@/lib/date";
import {
  editDayLedgerSelectionCore,
  type LedgerSelectionEdit,
  type LedgerSelectionRefusal,
} from "@/lib/day-ledger-edit";
import { db, today, writeTx } from "@/lib/db";
import {
  INTAKE_ACTIVE_REFUSAL_TEXT,
  setIntakeActive,
} from "@/lib/intake-active-write";
import { createIntakeItemCore } from "@/lib/intake-item-create";
import {
  deleteAdministrationLog,
  isLinkableSupply,
  // The historical-dose cores keep the shared, kind-neutral names; the aliases only
  // keep them apart from the Server Actions of the same name defined below.
  logHistoricalDose as logHistoricalDoseCore,
  markDoseSkipped,
  // The scheduled-dose resolution pair the Telegram tap and the offline replay
  // already write dated rows through (#3936).
  markDoseTaken,
  // The ONE intake_item_logs resolution core (#2039) — this action module holds no
  // dose-ledger SQL of its own.
  setDoseStatusCore,
  unretireDose,
  updateHistoricalDose as updateHistoricalDoseCore,
} from "@/lib/queries";
import { revalidateRoute } from "@/lib/revalidate";
import { lookupRxNormCandidates, lookupRxNormIngredients } from "@/lib/rxnorm";
import {
  getActiveSituations,
  getProfileAge,
  getSituations,
  getTimezone,
  resolveSituationId,
  setActiveSituations,
  setSituationIllnessType,
} from "@/lib/settings";
import { statedInstantOnDate } from "@/lib/stated-time";
import { generateAndStoreSuggestions } from "@/lib/supplement-suggest";
import { casUpdate, readForUpdate } from "@/lib/tx";
import { captureDelete } from "@/lib/undo-delete-db";
// The ONE spelling of every key this form's round trip uses, and the one parse of the
// four JSON payloads it posts (#4666) — the writer side is lib/intake-form-fields.
import { ADHERENCE_PREFIX } from "@/lib/adherence-patterns";
import { withAiLogContext } from "@/lib/ai-log";
import { poorSleepOverrideKey } from "@/lib/derived-situations";
import { doseLogDays } from "@/lib/dose-log-window";
import { doseConfirmMessage } from "@/lib/dose-outcome-text";
import { FOOD_TIMING_PREFIX } from "@/lib/food-drug-interactions";
import { historicalDoseErrorMessage } from "@/lib/historical-dose-error";
import {
  intakeItemDoseIds,
  sweepIntakeItemMarkers,
} from "@/lib/intake-marker-cleanup";
import { demoteIntakeObligation } from "@/lib/intake-obligation-write";
import { KEEP_APART_PREFIX } from "@/lib/intake-pairs";
import {
  parseDosage,
  spreadDoseTimes,
  WORKOUT_CONDITIONS,
} from "@/lib/intake-schedule";
import { isTrainingRelevant } from "@/lib/life-stage";
import { strOrNull } from "@/lib/parse";
import { dismissFinding } from "@/lib/queries";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import {
  DEMOTION_OUTCOME_TEXT,
  DEMOTION_PREFIX,
  demotionItemIdFromKey,
} from "@/lib/supplement-demotion";
import { SURGERY_BRIDGE_PREFIX } from "@/lib/surgery-bridge";
import type {
  DoseTakenOutcome,
  FoodTiming,
  HistoricalDoseOutcome,
  IntakeCondition,
  IntakeObligation,
} from "@/lib/types";
import {
  formError,
  formOk,
  type DoseStatusOutcome,
  type DoseStatusTarget,
  type FormResult,
} from "@/lib/types";

// Both intake surfaces (#746): a shared dose/item write is kind-agnostic (it acts
// by id), so it can affect the Nutrition → Supplements tab AND the Medications
// page. Revalidate both plus the dashboard. IntakeItem-only writes (situations, AI
// suggestions, adherence dismissals) revalidate just "/nutrition" at their call
// site.
function revalidateIntake() {
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  revalidateRoute("/supplies");
  revalidateRoute("/upcoming");
  // Both doors onto the cross-item dose ledger (#2417) — a backfill, amend or delete
  // made FROM the ledger has to leave the ledger showing what it just wrote.
  revalidateRoute("/history");
  revalidateRoute("/");
}

export async function addIntakeItem(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const postedSupplyId = Number(formData.get("supply_id") ?? 0);
  let supplyId: number | null = null;
  if (postedSupplyId) {
    const scope = await requireScope();
    if (!isLinkableSupply(cabinetViewer(scope.ids, scope.role), postedSupplyId))
      return formError("Couldn't find that shared bottle.");
    await requirePoolWriteAccess(postedSupplyId);
    supplyId = postedSupplyId;
  }
  const result = addIntakeItemCore(profileId, formData, supplyId);
  if (result.ok) revalidateIntake();
  return result;
}

export async function updateIntakeItem(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const supplyId = Number(formData.get("supply_id")) || null;
  if (supplyId != null) await requirePoolWriteAccess(supplyId);
  const result = updateIntakeItemCore(profile.id, formData);
  if (result.ok) revalidateIntake();
  return result;
}

// What the web tri-state check-off says per setDoseStatusCore outcome (#2039).
//
// Until the two dose-resolution cores were unified this action returned formOk()
// unconditionally, which is precisely the thing the repo's write rules forbid: the write
// can legitimately refuse (a forged/stale dose id, a paused item) and a silent "ok" tells
// the control the dose is resolved when nothing was written. Every reachable tap still
// answers ok — the control is only rendered for an active, non-retired dose — so this
// changes what a FORGED post is told, not what a real one sees.
// THE ANSWER CARRIES THE OUTCOME, NOT JUST `ok` (#2039/#280): a surface renders what
// happened through `doseConfirmMessage` — an off-cadence confirm names the schedule
// (#1602) — and `{ ok: true }` flattens that into a confirm the write may not have
// earned.
export type DoseStatusResult =
  { ok: true; outcome: DoseStatusOutcome } | { ok: false; error: string };

function doseStatusResult(
  outcome: DoseStatusOutcome,
  target: DoseStatusTarget
): DoseStatusResult {
  // The already-* pair is reachable only from a resolve-only tap. Contradicted, the
  // tap wrote nothing and it is a refusal; agreeing, the dose is where the tap wanted
  // it and an idempotent repeat is not one.
  const contradicted =
    (outcome === "already-taken" && target !== "taken") ||
    (outcome === "already-skipped" && target !== "skipped");
  if (contradicted || outcome === "stale-dose" || outcome === "inactive")
    return formError(doseConfirmMessage(outcome).text);
  return { ok: true, outcome };
}

// Set a single dose's status on a day to an explicit target — the web tri-state's
// write path (taken / skipped / clear). #232
//
// THE DAY IS OPTIONAL AND BOUNDED BY THE OFFER (#4424). Absent it is the profile's
// today. Present it is checked against `doseLogDays(localToday)` — the same upper-bound
// rule `resolveDayDoses` below applies, off the same constant — so a forged POST cannot
// reach TOMORROW through the ±2 the core allows a late Telegram tap. Widening it means
// widening `TAP_REACH["dose-status"]`, coupled to pointer retention.
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
export async function setDoseStatus(
  formData: StampedFormData
): Promise<DoseStatusResult> {
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
  const localToday = today(profileId);
  const posted = String(formData.get("date") ?? "");
  const date = posted === "" ? localToday : posted;
  if (
    !doseId ||
    (target !== "taken" && target !== "skipped" && target !== "clear") ||
    !doseLogDays(localToday).includes(date)
  ) {
    return formError("Couldn't update this dose.");
  }
  const outcome = setDoseStatusCore(
    profileId,
    doseId,
    date,
    target,
    // The tri-state check-off renders on the Nutrition/Medications pages, the day
    // ledger's rows and the quick-log sheet's dose list, all posting THIS action.
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"),
    {
      // THE STATE THE CONTROL WAS SHOWING, which decides whether this may overwrite
      // (#280): a row in a list of what a day still owes renders CLEAR whether or not
      // another device resolved it since, so from clear the tap may only resolve.
      // Absent — a caller rendering no state — keeps the explicit set this action
      // always did.
      resolveOnly:
        String(formData.get("from") ?? "") === "clear" && target !== "clear",
      // THE TIME THE TAP STATES (#4426), and the wire carries a WALL TIME, not an
      // instant: the day is this action's (`date`), so anchoring the two here is what
      // makes them one claim — a client that sent a resolved instant could contradict
      // the row it lands on. Only a `taken` states an administration; a skip and a
      // clear assert none. An unstated or invalid time keeps the tap instant today,
      // while a past-day row keeps its instant unknown, matching resolveDayDoses.
      takenAt:
        target === "taken"
          ? (statedInstantOnDate(
              date,
              String(formData.get("at") ?? ""),
              getTimezone(profileId)
            ) ?? (date === localToday ? undefined : null))
          : undefined,
    }
  );
  revalidateIntake();
  return doseStatusResult(outcome, target);
}

// ── Recent-past dose catch-up (#3936) ───────────────────────────────────────────
//
// One dated resolution for a set of scheduled doses, behind the quick-log sheet's day
// switcher.
//
// THE DAY IS BOUNDED BY THE OFFER, not by a second opinion about the window. The cores
// gate every write on `isDoseDateAccepted`, which is SYMMETRIC (|diff| <= 2) because a
// late Telegram tap may legitimately land a day either side of the reminder's own day.
// This surface only ever offers the PAST half — `doseLogDays(today)` — so the two
// differ by exactly the two future days, and a forged POST could otherwise log
// TOMORROW through a sheet that never offered it. So the day is checked against
// `doseLogDays` itself: not a re-implementation of the window (that stays the cores'
// one predicate, and an out-of-window day still comes back as their `stale-dose`), but
// the same "the form is an UPPER BOUND, never an instruction" rule the dose ids already
// obey, applied to the one field that was still an unbounded instruction.
//
// THE WHOLE-STACK TAP, and since #4424's dose leg only that — a single dose row is
// `DoseStatusControl` posting the row's day, so this no longer serves "a stack of one"
// as this header used to say. The bulk contract stands: the ids NAME an UPPER BOUND on
// the write, never an instruction. `pendingDayDoses` is re-run against fresh state and
// the named ids intersected with it, so a forged id, another profile's dose, a retired
// dose, a paused item or a dose already resolved from the phone writes nothing — the
// `logUsualRoutineCore` contract (#2458), one day further back. Every survivor still
// goes through the stateful core and can refuse on its own terms, and the answer carries
// each typed outcome unflattened so the sheet reports what was written, not what was
// asked for.
export type DayDoseResolution = {
  doseId: number;
  name: string;
  outcome: DoseTakenOutcome;
};

export type ResolveDayDosesResult =
  | { ok: false; error: string }
  | { ok: true; date: string; doses: DayDoseResolution[] };

export async function resolveDayDoses(
  formData: StampedFormData
): Promise<ResolveDayDosesResult> {
  // #4429: the day-ledger and the quick-log sheet's past-day switcher both post a
  // FOUND row for whichever profile is on screen, which may not be the acting one —
  // `markTaken`'s per-row arm already crosses this boundary, this bulk sibling did
  // not. `gateItemProfile` is the app's one answer to "which profile is this write
  // for" (posted `profile_id` → requireProfileWriteAccess, absent → acting).
  const profileId = await gateItemProfile(formData);
  const date = String(formData.get("date") ?? "");
  const status = String(formData.get("status") ?? "");
  const localToday = today(profileId);
  if (
    !isRealIsoDate(date) ||
    !doseLogDays(localToday).includes(date) ||
    (status !== "taken" && status !== "skipped")
  ) {
    return { ok: false, error: "Couldn't log those doses." };
  }
  const named = new Set(
    String(formData.get("dose_ids") ?? "")
      .split(",")
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  );
  // The quick-log sheet is the only mounting today; the field says so rather than the
  // action assuming it (#3087).
  const loggedVia = parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page");
  // ONE BUNDLE FOR THE WHOLE TAP (#4328): this is the ledger's bulk control, so the
  // rows it writes ARE one composed action and say so, rather than leaving the reader
  // to infer it from the minute they happened to land in. Only the taken arm carries
  // one — a skip is its own statement and never joins a collapsed row.
  const bundleId = newBundle();
  // THE SLOT'S STATED TIME (#5813), the wall-time `at` `setDoseStatus` reads, resolved
  // the same way: one instant for every row of the act.
  const tz = getTimezone(profileId);
  const takenAt =
    statedInstantOnDate(date, String(formData.get("at") ?? ""), tz) ??
    (date === localToday ? undefined : null);
  const taken = { takenAt, notifyMessageId: null, bundleId };
  const doses = pendingDayDoses(profileId, date)
    .filter((dose) => named.has(dose.doseId))
    .map((dose) => {
      const args = [
        profileId,
        dose.doseId,
        dose.itemId,
        date,
        loggedVia,
      ] as const;
      return {
        doseId: dose.doseId,
        name: dose.name,
        outcome:
          status === "taken"
            ? markDoseTaken(...args, taken)
            : markDoseSkipped(...args),
      };
    });
  revalidateIntake();
  return { ok: true, date, doses };
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
//
// THE SURFACE'S SUBJECT, NOT THE ACTING PROFILE (#4693). A dose-history panel stands
// on ONE item, so the surface hosting it names one subject — and on a subject-scoped
// container (`/medications/[id]` viewed cross-profile) an ADD follows that surface
// instead of the switcher. It takes the gate its amend path has had since #4009:
// `gateItemProfile` → requireProfileWriteAccess on the posted `profile_id`, falling
// back to the acting-profile gate on every single-subject mount, which posts none.
// The zone, the core call and the audit row all take the profile that gate returns —
// a wall time anchored in the CAREGIVER's zone would file the subject's dose at the
// wrong instant.
export async function logHistoricalDose(
  formData: StampedFormData
): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
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

  const recordedAt = zonedWallTimeToUtc(getTimezone(profileId), date, time);
  if (!recordedAt) return formError("Enter a valid dose date and time.");
  const loggedVia = parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page");

  const outcome = logHistoricalDoseCore(
    profileId,
    itemId,
    doseId,
    recordedAt,
    strOrNull(formData.get("amount")),
    formData.get("adjust_supply") === "1",
    loggedVia
  );
  if (outcome.kind === "logged") {
    recordAudit({
      loginId: login.id,
      profileId,
      action: AUDIT_ACTIONS.doseLogBackfill,
      target: String(itemId),
      detail: outcome.date,
    });
    revalidateIntake();
    revalidateRoute(`/medications/${itemId}`);
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
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106) — see
  // deleteAdministration. The wall time below re-anchors in the GATED profile's zone,
  // which is the same zone `HistoricalDoseForm` collected it in (the row carries it),
  // so a correction saved unchanged is byte-identical rather than shifted.
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
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
    occurredAt = zonedWallTimeToUtc(getTimezone(profileId), date, time);
    if (!occurredAt) return formError("Enter a valid dose date and time.");
  }

  const outcome = updateHistoricalDoseCore(
    profileId,
    itemId,
    logId,
    date,
    occurredAt,
    strOrNull(formData.get("amount"))
  );
  if (outcome.kind === "logged") {
    recordAudit({
      loginId: login.id,
      profileId,
      action: AUDIT_ACTIONS.doseLogAmend,
      target: String(itemId),
      detail: outcome.date,
    });
    revalidateIntake();
    revalidateRoute(`/medications/${itemId}`);
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
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106). On `/history`'s
  // `?view=everyone` the feed carries other members' rows, and a correction acts on
  // the row you found. `gateItemProfile` is the app's one answer to "which profile is
  // this per-item write for": it gates the posted `profile_id` through
  // requireProfileWriteAccess (reachable AND write, redirect otherwise) and falls back
  // to the acting-profile gate when no subject is posted. So the menu is an
  // affordance and this is the gate — a forged post naming a profile this login
  // cannot write aborts here, before deleteAdministrationLog runs.
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
  const logId = Number(formData.get("log_id"));
  if (!logId) return { undoId: null };
  const removed = deleteAdministrationLog(profileId, logId);
  if (removed) {
    recordAudit({
      loginId: login.id,
      profileId,
      action: AUDIT_ACTIONS.doseLogDelete,
      target: String(removed.itemId),
      detail: removed.date,
    });
    revalidateRoute(`/medications/${removed.itemId}`);
  }
  revalidateIntake();
  return { undoId: removed?.undoId ?? null };
}

// ── SELECTION EDIT ON THE DAY LEDGER (#4118) ───────────────────────────────────
//
// Three actions, one verb each (the owner's ruling: "one server action per operation
// over selected ids"), all over the SAME batch core — which walks every named row
// through its own domain's correction core, re-deriving the day's rows server-side
// first so the ids a surface names can only ever narrow what is written. The parse and
// the gate are here; every rule is in lib/day-ledger-edit.ts.
//
// THEY LIVE IN THE INTAKE ACTION MODULE, and a selection is deliberately mixed: one
// physical morning is a smoothie stack and its fermented foods, so a batch that could
// only reach one of the two tables would leave the user finishing the job by hand. This
// module already holds the audited historical-dose boundary the dose half needs; the
// food half's two cores are the whole of what it borrows.
export type LedgerSelectionEditResult =
  | {
      ok: true;
      /** Rows the correction cores wrote. */
      applied: number;
      /** Rows named but not written, each with the reason its core gave. */
      refused: LedgerSelectionRefusal[];
    }
  | { ok: false; error: string };

// The rows a batch names, off the wire: `serving_ids` / `dose_log_ids`, each a
// comma-separated list of positive integers. Anything else in either list is dropped
// here — an unreadable id is not a row and the core's day re-derivation would refuse it
// anyway.
function ledgerIds(formData: FormData, field: string): number[] {
  return String(formData.get(field) ?? "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

// The dispatch the three verbs share, AFTER each has run its own gate. The gate stays in
// the exported action — visibly, one call per action — because that is the surface
// lib/__tests__/actions-write-access.test.ts scans, and a gate hidden one frame down is a
// gate nothing watches.
function applyLedgerSelection(
  profileId: number,
  loginId: number,
  formData: FormData,
  edit: LedgerSelectionEdit
): LedgerSelectionEditResult {
  const date = String(formData.get("date") ?? "");
  const outcome = editDayLedgerSelectionCore(
    profileId,
    date,
    {
      servings: ledgerIds(formData, "serving_ids"),
      doses: ledgerIds(formData, "dose_log_ids"),
    },
    edit
  );
  if (outcome.kind === "invalid-edit")
    return formError("Couldn't apply that change.");
  if (outcome.kind === "nothing-selected")
    return formError(
      "Those rows are no longer on this day. Refresh and try again."
    );
  // AUDITED LIKE ANY OTHER RETROACTIVE DOSE WRITE (#1933), ROW FOR ROW. Amending or
  // removing what the record says was given is clinically significant whether it happens
  // one row at a time or twelve, so the batch writes exactly what twelve trips through
  // the ⋯ menu would: one `dose-log.amend` / `dose-log.delete` per CORRECTED ROW, keyed
  // on that row's item and the day it ended on.
  //
  // PER ROW IS THE #5618 CHANGE, and it is the medication case that makes it bite: a PRN
  // is taken more than once a day, so a batch over two administrations of one item used
  // to leave a single audit row where two single-row amends leave two. The owner ruling
  // bringing medication doses into selection says the batch writes "the same audit rows
  // the single-row amend already writes"; a count that collapses with the selection is
  // not the same rows.
  //
  // The REVALIDATE stays deduped — it is a cache instruction, not a record, and asking
  // twice for the same path is noise where a second audit row is a second fact.
  const action =
    edit.kind === "delete"
      ? AUDIT_ACTIONS.doseLogDelete
      : AUDIT_ACTIONS.doseLogAmend;
  for (const { itemId, date: detail } of outcome.auditedDoses)
    recordAudit({ loginId, profileId, action, target: String(itemId), detail });
  for (const itemId of new Set(outcome.auditedDoses.map((d) => d.itemId)))
    revalidateRoute(`/medications/${itemId}`);
  if (outcome.applied > 0) {
    revalidateIntake();
    // The food half moves day counters, which the trends rollups read.
    revalidateRoute("/trends");
  }
  return { ok: true, applied: outcome.applied, refused: outcome.refused };
}

// THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106), on all three:
// `gateItemProfile` gates a posted `profile_id` through requireProfileWriteAccess
// (reachable AND write, redirect otherwise) and falls back to the acting-profile gate.
// Every core call downstream is scoped to the profile it returns, so a row belonging to
// somebody else is not among the day's rows and nothing is written for it.

/** Stamp one profile-local wall time on every selected row (#3273's vocabulary). */
export async function setLedgerSelectionTime(
  formData: FormData
): Promise<LedgerSelectionEditResult> {
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
  return applyLedgerSelection(profileId, login.id, formData, {
    kind: "set-time",
    hhmm: String(formData.get("time") ?? ""),
  });
}

/** Re-date every selected row onto another day, each keeping its own wall clock. */
export async function moveLedgerSelectionToDay(
  formData: FormData
): Promise<LedgerSelectionEditResult> {
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
  return applyLedgerSelection(profileId, login.id, formData, {
    kind: "move-day",
    date: String(formData.get("to_date") ?? ""),
  });
}

/** Remove every selected row through its domain's undoable delete. */
export async function deleteLedgerSelection(
  formData: FormData
): Promise<LedgerSelectionEditResult> {
  const profileId = await gateItemProfile(formData);
  const { login } = await requireSession();
  return applyLedgerSelection(profileId, login.id, formData, {
    kind: "delete",
  });
}

// Toggle a single dose's TAKEN log for today (taken ↔ clear). A skipped dose
// (issue #232) counts as "not taken", so this flips it to taken. Kept as the
// dedicated take toggle; setDoseStatus is the general tri-state path.
export async function toggleTaken(
  formData: StampedFormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const doseId = Number(formData.get("dose_id"));
  if (!doseId) return formError("Couldn't find that dose.");
  const date = today(profile.id);
  const existing = db
    .prepare(
      "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { status: DoseStatusTarget } | undefined;
  const target = existing?.status === "taken" ? "clear" : "taken";
  const outcome = setDoseStatusCore(
    profile.id,
    doseId,
    date,
    target,
    parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")
  );
  revalidateIntake();
  return doseStatusResult(outcome, target);
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
  const outcome = setIntakeActive(profile.id, id, to);
  if (outcome !== "paused" && outcome !== "resumed") {
    return formError(INTAKE_ACTIVE_REFUSAL_TEXT[outcome]);
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

export async function deleteIntakeItem(
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
  revalidateRoute("/");
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
  revalidateRoute("/nutrition");
  if (note) return { ok: false, message: note };
  return {
    ok: true,
    message:
      inserted > 0
        ? `Added ${inserted} suggestion${inserted === 1 ? "" : "s"}.`
        : "No new suggestions from your current data.",
  };
}

// A create the accept's core refused, raised so it ABORTS that accept's transaction
// (see below) and re-typed as a form refusal outside it. Not a control-flow shortcut:
// a throw is the only way to undo a compare-and-swap that already landed in the
// transaction.
class CreateRefused extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "CreateRefused";
  }
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
  let accepted: boolean | "workout-schedule-unavailable";
  try {
    accepted = writeTx((tx): boolean | "workout-schedule-unavailable" => {
      const s = readForUpdate<{
        status: string;
        name: string;
        dosage: string | null;
        time_of_day: string | null;
        food_timing: FoodTiming;
        condition: IntakeCondition;
        obligation: IntakeObligation;
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
      if (
        WORKOUT_CONDITIONS.includes(s.condition) &&
        !isTrainingRelevant(getProfileAge(profile.id))
      ) {
        return "workout-schedule-unavailable" as const;
      }
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
      // The SAME create core the form uses (#4669). `kind` is stated OUTRIGHT rather
      // than left to the schema's `kind='supplement'` default: intake_item_suggestions
      // has no kind column because the suggester only ever proposes supplements, and
      // that is a fact about this caller, not something a column default should be
      // asked to remember.
      const created = createIntakeItemCore(profile.id, {
        name: s.name,
        kind: "supplement",
        provenance: { source: "manual" },
        notes: s.rationale,
        condition: s.condition,
        obligation: s.obligation,
        brand: s.brand,
        product: s.product,
        situation: s.situation,
        situationId,
        doses: times.map((t) => ({
          amount,
          time_of_day: t,
          food_timing: s.food_timing ?? "any",
        })),
      });
      // A refusal must ROLL THE CLAIM BACK, not merely be reported: returning it
      // would commit an `accepted` suggestion that produced no item, losing it
      // silently. A throw is the only thing better-sqlite3 treats as an abort, so the
      // refusal leaves the transaction as one and is re-typed on the way out.
      if (!created.ok) throw new CreateRefused(created.error);
      return true;
    });
  } catch (e) {
    if (e instanceof CreateRefused) return formError(e.refusal);
    throw e;
  }
  if (accepted === "workout-schedule-unavailable") {
    return formError(
      "Workout-based supplement schedules aren't available for this profile's age."
    );
  }
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
  revalidateRoute("/nutrition");
  return formOk();
}

// Look up RxNorm candidates for a free-text name (issue #144) — the ONLY network
// egress of the interaction feature, and it sends just the term (no PHI). Called
// from the item form's standardized-ingredient affordance; the user CONFIRMS a candidate,
// which fills the hidden `rxcui` field saved by add/updateIntakeItem. Degrades to []
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
// updateIntakeItem and both matchers try each of them. Degrades to [] (product-
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
  revalidateRoute("/nutrition");
  return formOk();
}

// Accept an obligation DEMOTION SUGGESTION (issue #1505 part 2): move a `must`/`should`
// supplement the user has effectively stopped taking to `may` — tracked, never pushed.
//
// THIS TAP IS THE OBLIGATION WRITE. The detector only ever suggests; nothing in the
// system demotes on its own (#559 — obligation is the user's declaration). The write
// core is auth-blind and returns a typed outcome, which is surfaced verbatim rather
// than confirmed unconditionally: accepting a stale card for a paused or already-`may`
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
  revalidateRoute("/nutrition");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
  return formOk();
}

// Dismiss an obligation DEMOTION SUGGESTION without acting on it — the calm half of the
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
  revalidateRoute("/nutrition");
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
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  return formOk();
}
