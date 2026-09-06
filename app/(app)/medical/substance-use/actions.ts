"use server";

import { revalidateRoute } from "@/lib/revalidate";
import {
  LOGGED_VIA_FIELD,
  parseWebOrigin,
  type WebLoggedVia,
  type StampedFormData,
} from "@/lib/logged-via";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "../../gate-item";
import { db, today, writeTx } from "@/lib/db";
import { isRealIsoDate, utcInstant } from "@/lib/date";
import { now } from "@/lib/clock";
import { judgeStatedAt } from "@/lib/stated-time";
import { getTimezone } from "@/lib/settings";
import {
  isSubstanceInstrument,
  substanceInstrumentDef,
  resolveSubstanceKey,
  substanceDef,
  substanceLabel,
  substanceNameError,
  capProgressLine,
  ALCOHOL_FOOD_GROUP,
  MAX_WEEKLY_CAP,
  MAX_SUBSTANCE_ENTRY_AMOUNT,
  type SubstanceKey,
  type SubstanceInstrument,
} from "@/lib/substance-use";
import {
  recordInstrumentScore,
  updateInstrumentScore,
  deleteInstrumentScore,
  getInstrumentScoreInstrument,
  instrumentMaxTotal,
  type InstrumentAnswer,
} from "@/lib/instrument-records";
import { validateProfileSubstanceName } from "@/lib/vocabulary-store";
import { logFoodServingCore, undoFoodServingCore } from "@/lib/food-log-write";
import {
  correctSubstanceEventCore,
  deleteSubstanceEventCore,
  logSubstanceUnitCore,
  undoSubstanceUnitCore,
  type SubstanceEventEditOutcome,
} from "@/lib/substance-log-write";
import { getSubstanceWeekState } from "@/lib/queries";
import { deleteFrequencyTargetRow } from "@/lib/frequency-target-delete";
import { isMinor } from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  addSubstanceDailyTotalCore,
  deleteSubstanceDailyTotalCore,
  type SubstanceHistoryMutationOutcome,
} from "@/lib/substance-daily-totals-write";

// #1174 gated the substance-use SURFACE (hidden nav + page redirect) to adults;
// #1279 closes the gap under it — Server Actions are independently POST-callable, so
// each write path re-checks life stage at the auth boundary (a UI-only gate is theater
// if the write core underneath has no independent check). Mirrors the page's
// isMinor(getProfileAge(profile.id)); refuses a KNOWN minor (unknown/adult age passes,
// per the module's documented "hide only on a positive under-age match" policy). The
// lib write cores stay auth-blind — the check belongs here, not below the action layer.
const MINOR_REFUSAL = "This isn't available for this profile.";

// Server Actions for the substance-use surface (issues #998, #1078). Standard
// per-profile: every action operates on the session's ACTIVE profile behind
// requireWriteAccess() (the gate is inlined so the write-access scanner sees a
// literal call in each body), then delegates to the auth-blind write cores (#319)
// and revalidates. Substance data never rides a notification or any push channel
// from here.

export type SubstanceInstrumentActionResult =
  { ok: true; id: number } | { ok: false; error: string };

// This week's post-write unit count rides the result so the one-tap log/undo
// reconciles optimistically against the server (the #748 item 2 pattern).
export type SubstanceLogResult =
  { ok: true; weekCount: number } | { ok: false; error: string };

export type SubstanceHistoryDeleteResult =
  | { kind: "deleted"; undoId: number }
  | { kind: "not-found"; undoId: null; error: string };

// THE CAP VERDICT RIDES THE WRITE (#998/#3279, #4424's substance leg). The tap
// surfaces render it beside the button — the offline exclusion below is argued from
// that readout — and the FORM surfaces had none, so a correction could take somebody
// past their weekly cap in silence. Derived AFTER the write, and null for a profile
// that set no target.
export type SubstanceHistoryWriteResult = SubstanceHistoryMutationOutcome & {
  readonly capProgress?: string | null;
};

function capProgressAfterWrite(
  profileId: number,
  substance: SubstanceKey
): string | null {
  const week = getSubstanceWeekState(profileId, substance);
  return week.status ? capProgressLine(week.status, substance) : null;
}

function revalidateSubstanceUse() {
  revalidateRoute("/records/specialty/substance-use");
  revalidateRoute("/history");
  revalidateRoute("/nutrition");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
}

// Record ONE substance-instrument score. Two shapes (the #716 action contract):
//   • in-app administration (AUDIT-C, and DAST-10 since #1085) → `answers` carries
//     every item's answer, validated against the item's OWN option set, and the
//     total is derived server-side from them (the source of truth);
//   • outside total-only entry (AUDIT, and any in-app instrument done elsewhere —
//     an imported/outside total lands in the SAME canonical_name series) →
//     `total` is submitted directly with no answers.
export async function recordSubstanceInstrumentAction(
  formData: FormData
): Promise<SubstanceInstrumentActionResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id)))
    return { ok: false, error: MINOR_REFUSAL };

  const instrumentRaw = String(formData.get("instrument") ?? "");
  if (!isSubstanceInstrument(instrumentRaw))
    return { ok: false, error: "Pick a valid instrument." };
  const instrument: SubstanceInstrument = instrumentRaw;
  const def = substanceInstrumentDef(instrument);

  const dateRaw = String(formData.get("date") ?? "").trim();
  const date = isRealIsoDate(dateRaw) ? dateRaw : today(profile.id);

  const mode = String(formData.get("mode") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  let total: number;
  let answers: InstrumentAnswer[] | undefined;

  if (mode === "administer") {
    // Only an in-app instrument (baked item text — the licensing determination in
    // lib/substance-use.ts) may be administered here.
    if (def.entry !== "in-app" || def.items.length === 0) {
      return { ok: false, error: "Enter this instrument as a total score." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(formData.get("answers") ?? "[]"));
    } catch {
      return { ok: false, error: "Couldn't read the answers." };
    }
    if (!Array.isArray(parsed) || parsed.length !== def.items.length) {
      return { ok: false, error: "Answer every item." };
    }
    const parsedAnswers: InstrumentAnswer[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const a = Number(parsed[i]);
      // Validate against the item's OWN option values (0..4 for AUDIT-C).
      if (
        !Number.isInteger(a) ||
        !def.items[i].options.some((o) => o.value === a)
      ) {
        return { ok: false, error: "Answer every item." };
      }
      parsedAnswers.push({ itemIndex: i, answer: a });
    }
    answers = parsedAnswers;
    total = parsedAnswers.reduce((sum, a) => sum + a.answer, 0);
  } else {
    // Outside total-only entry.
    const t = Number(formData.get("total"));
    if (!Number.isInteger(t) || t < 0 || t > def.maxTotal) {
      return {
        ok: false,
        error: `Enter a total between 0 and ${def.maxTotal}.`,
      };
    }
    total = t;
  }

  const id = recordInstrumentScore(
    profile.id,
    { instrument, date, total, answers, notes },
    "page"
  );
  // The core now carries the same life-stage gate this action opened with (#2107),
  // so the refusal is rendered rather than assumed away — the action's own check
  // above is defense in depth over it, not the only copy.
  if (id == null) return { ok: false, error: MINOR_REFUSAL };
  revalidateSubstanceUse();
  return { ok: true, id };
}

// Log ONE unit of a substance for today, dispatched to the substance's ledger
// (#1078 split-ledger, one computation per substance): alcohol goes through the
// SAME auth-blind food-log core the Nutrition one-tap bar and the Telegram button
// use (a standard drink IS one serving of the curated `alcohol` food group,
// #860/#944); nicotine/cannabis go through the substance_daily_totals core. Both answer
// from the typed outcome — never unconditionally confirm.
export async function logSubstanceUnitAction(
  formData: StampedFormData
): Promise<SubstanceLogResult> {
  // #4932: the quick-log sheet's subject chip mounts this SAME control cross-profile,
  // so the tap follows gateItemProfile() → requireProfileWriteAccess(subjectProfileId)
  // like every other sheet body; every other mount posts no subject and falls back
  // to the acting-profile gate.
  const profileId = await gateItemProfile(formData);
  if (isMinor(getProfileAge(profileId)))
    return { ok: false, error: MINOR_REFUSAL };
  const substance = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  if (substance === null) return { ok: false, error: "Unknown substance." };
  return logOneUnit(profileId, substance, webOrigin(formData));
}

// The surface this post came from, defaulting to the substance page's own form when
// the client says nothing (an older build, or a form that never learned to declare
// itself). The parse refuses anything outside the web subset, so a forged field cannot
// dress a browser tap up as a Telegram one.
//
// IT TAKES THE STAMPED PAYLOAD, which is what makes "every action that reads a surface
// is branded" structural in this file rather than a fact somebody has to re-census.
// This helper is the reason the miss was possible: three actions read the origin
// THROUGH IT rather than by naming `parseWebOrigin`, so a sweep keyed on that name saw
// one of the three. Narrowed here, a fourth caller cannot compile until it is branded
// too — the census's job, done by the compiler.
function webOrigin(formData: StampedFormData): WebLoggedVia {
  return parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page");
}

// The split-ledger dispatch, factored out so the keyed tap above and the NAMED tap
// below are one write path with one revalidation — #3326 adds a way to reach this,
// never a second way to do it.
function logOneUnit(
  profileId: number,
  substance: SubstanceKey,
  // The mounting surface, read off the post (#3087): the substance row is offered on
  // its own page AND in the quick-log sheet, so the action cannot know which it is.
  loggedVia: WebLoggedVia
): SubstanceLogResult {
  const outcome =
    substanceDef(substance).ledger === "food-log"
      ? logFoodServingCore(
          profileId,
          ALCOHOL_FOOD_GROUP,
          today(profileId),
          loggedVia
        )
      : logSubstanceUnitCore(profileId, substance, today(profileId), loggedVia);
  if (outcome.kind !== "logged")
    return { ok: false, error: "Couldn't log that." };
  revalidateSubstanceUse();
  return {
    ok: true,
    weekCount: getSubstanceWeekState(profileId, substance).count,
  };
}

// ---- Naming your own substance (#3326) -------------------------------------
//
// THE ENTRY POINT, AND THERE IS NO CREATE STEP. #3323 shipped the whole custom
// vocabulary and nothing in the app could reach it. A custom substance's identity IS
// its normalized name in the ledger — no registration row, no new table — so LOGGING
// IT IS CREATING IT, and this action is exactly `logSubstanceUnitAction` reached by a
// typed name instead of a known key.
//
// WHAT IT ADDS over the keyed tap: the surface-level name gate. `resolveSubstanceKey`
// truncates at 60 characters, which is right for a stored key and wrong for a person
// typing (see validateSubstanceName). A too-long name is REFUSED with a sentence here
// as well as in the form, because a Server Action is independently POST-callable.
//
// A TYPED NAME NEVER REACHES THE NUTRITION LEDGER. It can, however, resolve ONTO a
// curated key: "Alcohol" collapses to `alcohol` so a typed name can never shadow the
// catalog with a second ledger, and that one case rides food-log exactly as the
// Alcohol card's own tap does. Nothing a person INVENTS lands there — `substanceDef`
// gives every custom key the substance-log ledger, always.
//
// NOR DOES IT SHADOW A NAME THE PERSON ALREADY USES (#3325). This is the one place a
// custom substance key is MINTED, so it is the one place the case-fold belongs: the
// name is validated and resolved against THIS PROFILE'S own spellings, first-seen
// first, so a typed "kratom" joins the existing "Kratom" card rather than opening a
// second ledger that also looks correct. Case is still stored verbatim — "MDMA" keeps
// its capitals — because the fold is only ever COMPARED (lib/vocabulary-fold.ts).
// The keyed taps below stay bare: their key came from a card the app just rendered.
//
// The resolved key rides back so the caller can name what it actually logged: someone
// who types "alcohol" is told the drink landed on Alcohol rather than being left to
// wonder where their new card went.
export type TrackSubstanceResult =
  | { ok: true; substance: SubstanceKey; label: string; weekCount: number }
  | { ok: false; error: string };

export async function trackSubstanceUseAction(
  formData: StampedFormData
): Promise<TrackSubstanceResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id)))
    return { ok: false, error: MINOR_REFUSAL };
  const name = validateProfileSubstanceName(
    profile.id,
    String(formData.get("name") ?? "")
  );
  if (!name.ok) return { ok: false, error: substanceNameError(name.reason) };
  const logged = logOneUnit(profile.id, name.key, webOrigin(formData));
  if (!logged.ok) return logged;
  return {
    ok: true,
    substance: name.key,
    label: substanceLabel(name.key),
    weekCount: logged.weekCount,
  };
}

// Undo one unit logged today (idempotent — a no-op at zero), same dispatch.
export async function undoSubstanceUnitAction(
  formData: FormData
): Promise<SubstanceLogResult> {
  // #4932: the add's inverse must resolve the SAME subject the add did, so it reads
  // it through the same gateItemProfile().
  const profileId = await gateItemProfile(formData);
  if (isMinor(getProfileAge(profileId)))
    return { ok: false, error: MINOR_REFUSAL };
  const substance = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  if (substance === null) return { ok: false, error: "Unknown substance." };
  const outcome =
    substanceDef(substance).ledger === "food-log"
      ? undoFoodServingCore(profileId, ALCOHOL_FOOD_GROUP, today(profileId))
      : undoSubstanceUnitCore(profileId, substance, today(profileId));
  if (outcome.kind !== "undone")
    return { ok: false, error: "Couldn't undo that." };
  revalidateSubstanceUse();
  return {
    ok: true,
    weekCount: getSubstanceWeekState(profileId, substance).count,
  };
}

function historyInput(
  formData: FormData,
  maxDate: string
):
  | {
      ok: true;
      substance: SubstanceKey;
      date: string;
      amount: number;
      notes: string | null;
    }
  | { ok: false; outcome: SubstanceHistoryMutationOutcome } {
  const substanceRaw = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  if (substanceRaw === null)
    return { ok: false, outcome: { kind: "unknown-substance" } };
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date) || date > maxDate)
    return { ok: false, outcome: { kind: "invalid-date" } };
  const amount = Number(formData.get("amount"));
  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > MAX_SUBSTANCE_ENTRY_AMOUNT
  ) {
    return { ok: false, outcome: { kind: "invalid-amount" } };
  }
  const notesRaw = String(formData.get("notes") ?? "").trim();
  return {
    ok: true,
    substance: substanceRaw,
    date,
    amount,
    notes: notesRaw.slice(0, 2000) || null,
  };
}

// THE MINUTE A USE STATES (#3295 phase 1; every substance since #5026 phase 2), read
// off the post and gated here.
//
// NO LEDGER PREDICATE ANY MORE. Until phase 2 this refused a stated instant for
// anything but alcohol, because `substance_daily_totals` is UNIQUE per (profile, date,
// substance) and had nowhere to put one — a field the store could not hold must not be
// half-kept. Both ledgers carry `occurred_at` + `time_source` now, so the refusal has
// no subject left and the door offers a time for nicotine, cannabis and every custom
// key on the same terms it offers one for a drink.
//
// THE GATE IS `judgeStatedAt` — the same two rules every stated instant in the app
// passes (not meaningfully in the future, and the instant's profile-local date IS the
// row's `date`), asked of the SUBJECT's zone and the server's clock. A refusal DROPS
// THE STATEMENT AND KEEPS THE WRITE, which is the log path's side of that function's
// documented split: losing the stated minute is cosmetic, losing the use is not.
function statedUseInstant(
  profileId: number,
  date: string,
  formData: FormData
): string | null {
  const raw = String(formData.get("stated_at") ?? "").trim();
  if (!raw) return null;
  const verdict = judgeStatedAt(
    new Date(raw),
    getTimezone(profileId),
    date,
    now()
  );
  return verdict.kind === "accepted" ? utcInstant(verdict.at) : null;
}

// Historical add/correction (#2009). The action contract never names the backing
// store; the auth-blind core dispatches from the validated substance catalog.
export async function addSubstanceDailyTotalAction(
  formData: StampedFormData
): Promise<SubstanceHistoryWriteResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id))) return { kind: "not-found" };
  const parsed = historyInput(formData, today(profile.id));
  if (!parsed.ok) return parsed.outcome;
  // READ OFF THE POST, not hardcoded (#3567). Behaviour is unchanged today — an
  // unstamped post takes `webOrigin`'s `page` fallback, which is what the literal
  // said — but the claim is now made by the mounting instead of by this file, which
  // cannot know where its form is rendered.
  const outcome = addSubstanceDailyTotalCore(
    profile.id,
    parsed.substance,
    {
      ...parsed,
      statedAt: statedUseInstant(profile.id, parsed.date, formData),
    },
    webOrigin(formData)
  );
  if (outcome.kind !== "added") return outcome;
  revalidateSubstanceUse();
  return {
    kind: "added",
    id: outcome.id,
    capProgress: capProgressAfterWrite(profile.id, parsed.substance),
  };
}

// THE SUBJECT AND ITS GATES, in one place, because five actions on this surface ask
// the identical three questions of the identical profile (#4009 item 1 / #2106,
// #1174/#1279): `/history`'s `?view=everyone` posts the ROW's own `profile_id`, and
// `gateItemProfile` gates it through requireProfileWriteAccess — reachable AND write,
// redirect otherwise — falling back to the acting-profile gate when no subject is
// posted. The AGE gate and the DAY bound move with that subject: a caregiver acting as
// an adult must not correct a MINOR member's substance row, and `today()` in the
// caregiver's zone could refuse (or admit) a date the subject's own calendar reads
// differently. The read these corrections face is gated on the SUBJECT's age in
// lib/history.ts; the write asks the same question of the same profile or the two
// disagree.

// CORRECT ONE RECORDED USE (#5026 phase 2), replacing the day-count correction that
// stood here. A consumable is an EVENT, so what a correction addresses is the event:
// its DAY, the minute somebody stated for it, and its NOTE (#5304). Amount is gone
// from the contract because one event is one unit.
export async function correctSubstanceUseAction(
  formData: FormData
): Promise<SubstanceEventEditOutcome> {
  const profileId = await gateItemProfile(formData);
  if (isMinor(getProfileAge(profileId))) return { kind: "not-found" };
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0) return { kind: "not-found" };
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date)) return { kind: "invalid-date" };
  // THREE STATES ON THE WIRE, matching the core's patch convention: a `stated_at` that
  // is absent leaves the row's instant alone, an EMPTY one clears it back to "nobody
  // said", and a value states it. The form always posts the field, so clearing a time
  // is reachable — which is the half a nullable-or-missing wire shape loses.
  const raw = formData.get("stated_at");
  const statedAt =
    raw === null
      ? undefined
      : String(raw).trim() === ""
        ? null
        : new Date(String(raw));
  // THE NOTE, ON THE SAME TERMS: absent leaves it, present states it — including
  // present-and-empty, which is how a note is CLEARED (#5077's ask). The core folds
  // blank to NULL.
  const rawNotes = formData.get("notes");
  const outcome = correctSubstanceEventCore(profileId, eventId, {
    date,
    statedAt,
    notes: rawNotes === null ? undefined : String(rawNotes),
  });
  if (outcome.kind !== "updated") return outcome;
  revalidateSubstanceUse();
  return outcome;
}

// DELETE ONE RECORDED USE (#5026 phase 2) — the record row's ⋯, addressing the event
// the way the drink beside it addresses its serving. The day-level delete below is the
// other operation and takes the whole day.
export async function deleteSubstanceUseAction(
  formData: FormData
): Promise<SubstanceHistoryDeleteResult> {
  const profileId = await gateItemProfile(formData);
  const notFound = {
    kind: "not-found",
    undoId: null,
    error: "Couldn't find that entry.",
  } as const;
  if (isMinor(getProfileAge(profileId))) return notFound;
  const eventId = Number(formData.get("event_id"));
  if (!Number.isInteger(eventId) || eventId <= 0) return notFound;
  const outcome = deleteSubstanceEventCore(profileId, eventId);
  if (outcome.kind !== "deleted") return notFound;
  revalidateSubstanceUse();
  return { kind: "deleted", undoId: outcome.undoId };
}

export async function deleteSubstanceDailyTotalAction(
  formData: FormData
): Promise<SubstanceHistoryDeleteResult> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): `/history`'s
  // `?view=everyone` posts the row's own `profile_id`, and `gateItemProfile` gates it
  // through requireProfileWriteAccess — reachable AND write, redirect otherwise —
  // falling back to the acting-profile gate when no subject is posted. The ⋯ menu is
  // the affordance; this is the gate.
  //
  // THE AGE GATE AND THE DAY BOUND MOVE WITH THE SUBJECT (#1174/#1279). Both were
  // asked of the acting profile, which is the wrong question the moment the row is
  // somebody else's: a caregiver acting as an adult could otherwise correct a MINOR
  // member's substance row, and `today()` in the caregiver's zone could refuse (or
  // admit) a date the subject's own calendar reads differently. The read this
  // corrects is gated on the SUBJECT's age in lib/history.ts; the write must ask the
  // same question of the same profile or the two disagree.
  const profileId = await gateItemProfile(formData);
  if (isMinor(getProfileAge(profileId))) {
    return {
      kind: "not-found",
      undoId: null,
      error: "Couldn't find that entry.",
    };
  }
  const substance = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  const id = Number(formData.get("id"));
  if (substance === null || !Number.isInteger(id) || id <= 0) {
    return {
      kind: "not-found",
      undoId: null,
      error: "Couldn't find that entry.",
    };
  }
  const outcome = deleteSubstanceDailyTotalCore(profileId, substance, id);
  if (outcome.kind !== "deleted") {
    return {
      kind: "not-found",
      undoId: null,
      error: "Couldn't find that entry.",
    };
  }
  revalidateSubstanceUse();
  return { kind: "deleted", undoId: outcome.undoId };
}

// Set (or update) a weekly reduction target: a CAP of units per week (standard
// drinks / uses), 0..MAX_WEEKLY_CAP (0 = a substance-free week target — "Dry
// January", a quit target). One target per (profile, substance) via the
// migration-072 partial unique index; re-setting updates the cap in place.
// User-initiated and reversible — never auto-created.
export async function setSubstanceTargetAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id))) return formError(MINOR_REFUSAL);
  const substance = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  if (substance === null) return formError("Unknown substance.");
  const capRaw = Number(formData.get("cap"));
  if (!Number.isInteger(capRaw) || capRaw < 0 || capRaw > MAX_WEEKLY_CAP) {
    return formError(`Enter a weekly cap between 0 and ${MAX_WEEKLY_CAP}.`);
  }
  writeTx(() => {
    db.prepare(
      `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
       VALUES ('substance', ?, ?, ?)
       ON CONFLICT (profile_id, scope_value) WHERE scope_kind = 'substance'
       DO UPDATE SET per_week = excluded.per_week`
    ).run(substance, capRaw, profile.id);
  });
  revalidateSubstanceUse();
  return formOk();
}

// Remove the reduction target through the shared delete core (lib/frequency-target-delete),
// which nulls any protocol that referenced it FIRST — the row-ops side-state rule, since a
// live protocols.frequency_target_id FK would block the delete. The lookup above scopes it
// to a substance target so it can't touch a training/food row.
export async function clearSubstanceTargetAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id))) return formError(MINOR_REFUSAL);
  const substance = resolveSubstanceKey(
    String(formData.get("substance") ?? "")
  );
  if (substance === null) return formError("Unknown substance.");
  const target = db
    .prepare(
      `SELECT id FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'substance' AND scope_value = ?`
    )
    .get(profile.id, substance) as { id: number } | undefined;
  if (!target) return formOk(); // idempotent — nothing to clear
  deleteFrequencyTargetRow(profile.id, target.id);
  revalidateSubstanceUse();
  return formOk();
}

// ---- Correcting a recorded screening score (#1396) --------------------------
// The substance-use siblings of the mental-health correction actions: same shared
// auth-blind core, same typed outcomes, plus this surface's own life-stage gate
// (a Server Action is independently POST-callable, so the check is re-run here).
// The target row's OWN instrument decides the valid range — never a posted one.

export async function updateSubstanceInstrumentAction(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id))) return formError(MINOR_REFUSAL);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that score.");
  const instrument = getInstrumentScoreInstrument(profile.id, id);
  if (!instrument) return formError("Couldn't find that score.");
  const dateRaw = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(dateRaw)) return formError("Enter a valid date.");
  const maxTotal = instrumentMaxTotal(instrument);
  const total = Number(formData.get("total"));
  if (!Number.isInteger(total) || total < 0 || total > maxTotal)
    return formError(`Enter a total between 0 and ${maxTotal}.`);

  const outcome = updateInstrumentScore(profile.id, id, {
    date: dateRaw,
    total,
  });
  if (outcome.kind === "not-found")
    return formError("Couldn't find that score.");
  if (outcome.kind === "answers-derived")
    return formError(
      "This score was answered item by item, so its total comes from those answers. Delete it and answer again to correct it."
    );
  revalidateSubstanceUse();
  return formOk();
}

export async function deleteSubstanceInstrumentAction(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  if (isMinor(getProfileAge(profile.id))) return { undoId: null };
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  const outcome = deleteInstrumentScore(profile.id, id);
  if (outcome.kind === "not-found") return { undoId: null };
  revalidateSubstanceUse();
  return { undoId: outcome.undoId };
}
