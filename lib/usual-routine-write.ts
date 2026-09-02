// Auth-blind write core for the composed "your usual <window>" one-tap (#2458).
// profileId first, never imports lib/auth — the Server Action (and the Telegram
// handler, #2460) owns the gate.
//
// ── IT STILL DOES NOT LOG ANYTHING ON ANYONE'S BEHALF ────────────────────────
//
// Composing two offers does not turn either of them into an instruction. What the
// bundle buys is SPEED for one physical event — a smoothie with the supplements in
// it, five writes the ledger says happen in the same minute — and the user still
// makes the tap, on a control whose label names every serving and every dose it will
// perform. Nothing here runs on a schedule, from a nudge, or from any surface the
// user did not open or tap.
//
// ── A STALE TAP REFUSES; IT NEVER DOUBLE-LOGS ────────────────────────────────
//
// The composed button is exactly where a stale tap gets expensive — five writes
// instead of one — so both halves re-derive from FRESH SERVER STATE and write only
// the intersection with what the button named:
//
//   • food: `logUsualFoodCore` already owns that contract (it re-runs
//     `getUsualFoodOffer` inside its own IMMEDIATE transaction and intersects), so
//     this core delegates rather than re-spelling it. Its all-or-nothing semantics
//     and its `UsualFoodRefused` rollback are unchanged;
//   • doses: `getPendingRoutineDoses` is re-run here and the named ids are
//     intersected with it, so a forged id, another profile's dose, a retired dose, a
//     paused item or a dose already confirmed from the phone writes nothing. Under
//     that, every confirm still goes through `markDoseTaken` — the stateful core with
//     its typed refusals and its supply snapshot — so even a dose that survived the
//     intersection can refuse, and its refusal is reported rather than assumed away.
//
// ── THE TWO HALVES DO NOT SHARE A TRANSACTION, DELIBERATELY ──────────────────
//
// A dose refusal MUST NOT unwind breakfast. The food set is one user intent and lands
// whole or not at all (that is #2380's rule and it is untouched); the doses are three
// independent confirms against a supply ledger. A paused item discovered at write time
// yields an honest PARTIAL outcome — the food that was genuinely eaten stays logged and
// the answer says which doses did not land. Rolling the servings back because a
// creatine bottle was paused would be the app deciding it knows better than the ledger.
//
// ── THE DATE IS THE CALLER'S, AND BOTH HALVES USE THE SAME ONE ───────────────
//
// This core used to resolve `today(profileId)` and refuse to be told a day, so that a
// bulk "usual" could never backfill. The intent survives #4118; the mechanism moved. A
// bundle aimed at a day that is not the profile's today stamps `USUAL_BACKFILL` on BOTH
// halves — one tap is one tap — and `getFoodRegularity` excludes that stamp from the
// evidence window it derives the offer from. The write can therefore no longer become
// its own reason, while the rows still count everywhere a person looks.
//
// The food half owns the reach (`isUsualBackfillDateAccepted`: today and the six days
// before) and the dose half now goes the whole way with it (#4305, owner ruling
// 2026-08-31) — ONE TAP FILLS THE WHOLE MORNING, which is the case #4118 was filed for
// and is usually three or more days back by the time anybody notices the hole.
//
// It gets there by WHICH WRITER IT PICKS, not by widening anything:
//
//   • inside `isDoseDateAccepted` (±2) the dose half is `markDoseTaken`, unchanged —
//     the ordinary dated confirm, with its supply coupling and its typed refusals;
//   • outside it, and only inside the food half's reach, each dose goes through
//     `logHistoricalDose` — the SAME audited deep-door core the `/history` backfill
//     writes through, which is bounded by the medication course rather than by the
//     stale-button window.
//
// `DOSE_LOG_DATE_WINDOW_DAYS` therefore keeps its ONE meaning: how far a stale tap on a
// message may reach, coupled to Telegram pointer retention. No other surface changes,
// and no ordinary tap reaches further than it did.
//
// TWO PROPERTIES THE DEEP DOOR HAS THAT THE STALE-TAP WRITER DOES NOT, both wanted:
// a medication whose courses do not cover that day is refused `outside-course` rather
// than written, and the amount snapshotted onto the row is the dose's CURRENT amount.
// The second is a known, accepted cost until #3984 versions amounts — it is exactly what
// the deep door does today, so it is not a new one.
//
// ── AND IT CHANGES NOTHING ELSE ──────────────────────────────────────────────
//
// No obligation is written (obligation is declared only, forever — #2419). No
// situation state moves. Nothing is pushed, no finding is raised, no dedupe key is
// minted, no cadence row is touched. Adherence moves exactly where dueness already
// existed, as if each row had been tapped by hand.

import { now as clockNow } from "./clock";
import { today } from "./db";
import { recordAudit } from "./audit";
import { AUDIT_ACTIONS } from "./audit-actions";
import { isDoseDateAccepted } from "./dose-log-window";
import { parseClockHhmm } from "./format-date";
import { zonedDateParts } from "./date";
import { statedInstantOnDate } from "./stated-time";
import { getTimezone } from "./settings";
import { USUAL_BACKFILL, type LoggedVia } from "./logged-via";
import { logUsualFoodCore, type UsualFoodLogged } from "./food-usual-write";
import type { FoodEatingTime } from "./food-log-write";
import { isUsualBackfillDateAccepted } from "./food-regularity";
import type { FoodSlot } from "./food-slot";
import { logHistoricalDose, markDoseTaken } from "./queries/intake/adherence";
import {
  getPendingRoutineDoses,
  type PendingDayDose,
} from "./queries/usual-routine";
import type { DoseTakenOutcome, HistoricalDoseOutcome } from "./types";

// What one named dose actually did — the writer's own typed answer, carried out
// unflattened so the surface can say "3 taken, 1 already logged" rather than a bare
// count. The composed answer may never claim more than was written.
//
// `outside-course` is the ONE state only the dated writer can reach (#4305): a
// medication whose recorded courses do not cover that day. It is kept as itself rather
// than folded into `stale-dose`, because "that dose doesn't exist" is not what happened
// and a refusal that lies is the defect #1933 removed from this very core.
export type UsualRoutineDoseOutcome = DoseTakenOutcome | "outside-course";

export interface UsualRoutineDoseResult {
  doseId: number;
  name: string;
  outcome: UsualRoutineDoseOutcome;
}

// `nothing-to-log` only when BOTH halves came back empty: the offer the tap came from
// no longer stands in any part. Anything else is `logged`, even when one half is empty
// — a partial truth is still a truth and the surface renders it.
export type UsualRoutineOutcome =
  | {
      kind: "logged";
      date: string;
      window: FoodSlot;
      groups: UsualFoodLogged[];
      doses: UsualRoutineDoseResult[];
    }
  | { kind: "nothing-to-log" }
  // The target day is malformed, in the future, or out of the bundle's reach (#4118).
  // Carried up from the food half, which owns that bound.
  | { kind: "invalid-date" };

// A dose confirm that actually moved the ledger. `logged-off-day` counts: the row was
// written and supply moved; only the framing differs (#1602).
export function usualRoutineDoseLogged(
  outcome: UsualRoutineDoseOutcome
): boolean {
  return outcome === "logged" || outcome === "logged-off-day";
}

// ── THE DATED DOSE WRITE (#4305) ─────────────────────────────────────────────

// WHAT TIME A BUNDLE SAYS A DOSE WAS TAKEN, on a day the ±2 window no longer reaches.
// `logHistoricalDose` derives the row's DATE from the instant it is handed, so an
// instant is not optional here — it has to land on `date` or the row lands on the wrong
// day. The rule is the one the dose-history panel's missed-day offer already uses, and
// for the same reason: it is a one-tap backfill with no visible time field, so the
// dose's OWN declared clock is the only statement standing for it. Free text that is a
// bucket word rather than a clock ("Morning", "with dinner") states no hour, and neither
// does an anytime dose, so those fall back to the wall clock the tap happened at — the
// same default the deep door's form prefills. Null only on a DST gap, which refuses the
// write rather than silently moving the hour.
function datedDoseWrite(
  profileId: number,
  tz: string,
  date: string,
  dose: PendingDayDose,
  loggedVia: LoggedVia
): UsualRoutineDoseOutcome {
  const hhmm =
    parseClockHhmm(dose.timeOfDay) ?? zonedDateParts(tz, clockNow()).hhmm;
  const at = statedInstantOnDate(date, hhmm, tz);
  if (!at) return "stale-dose";
  return datedDoseOutcome(
    // amountOverride null keeps the dose row's own amount, and supply moves exactly as
    // the ±2 writer moves it — one tap is one tap, whichever writer it reaches.
    logHistoricalDose(
      profileId,
      dose.itemId,
      dose.doseId,
      at,
      null,
      true,
      loggedVia
    )
  );
}

// The deep door's answer in the composed tap's vocabulary. Every member is carried
// across as itself; `invalid-time` is the only one with no counterpart — it means the
// instant above did not survive its own day (a DST gap), so nothing was written and
// nothing about the dose is wrong, which is what `stale-dose` already says to a surface.
// `duplicate` is unreachable: it is the PRN dedup, and a `may` item has no dueness at
// all (#1505), so no `may` dose is ever in a standing bundle.
function datedDoseOutcome(
  outcome: HistoricalDoseOutcome
): UsualRoutineDoseOutcome {
  switch (outcome.kind) {
    case "logged":
      return "logged";
    case "already-taken":
    case "already-skipped":
    case "outside-course":
      return outcome.kind;
    default:
      return "stale-dose";
  }
}

// Log the still-offered half of `namedGroups` into `window`, then confirm the
// still-pending half of `namedDoseIds`, on `date`.
//
// Both named lists are UPPER BOUNDS on the write and never an instruction to write
// outside the offer that currently stands.
export function logUsualRoutineCore(
  profileId: number,
  window: FoodSlot,
  // WHICH DAY (#4118) — see the header. Required, no default; the food half bounds it.
  date: string,
  namedGroups: readonly string[],
  namedDoseIds: readonly number[],
  // Which surface ran the composed one-tap (#3087). Both halves — the food servings
  // and the doses — stamp the SAME value, because one tap is one tap.
  loggedVia: LoggedVia,
  // WHICH MESSAGE'S TAP THIS IS (#2264/#2460). Both halves stamp it, through the same
  // origin paths `handleFoodLog` and `handleDoseTap` use — so one composed tap is
  // attributed exactly as the individual taps it replaces would have been. The
  // dashboard control passes nothing and both stores record NULL.
  notifyMessageId?: number | null,
  // WHEN THE BUNDLE WAS EATEN (#4438) — the bar's sticky statement, or the chat tap's
  // own instant. It reaches the FOOD half only: a dose's administration time is the
  // dose half's own question, already answered by the writer this core picks below, and
  // an eating time is not a claim about when a capsule went down.
  time?: FoodEatingTime
): UsualRoutineOutcome {
  const t = today(profileId);
  // ONE BOUND, ASKED ONCE. A dose-only bundle would otherwise skip the food half's
  // check entirely and reach `markDoseTaken`'s wider ±2 — including TOMORROW, which no
  // usual offer has ever named. `logUsualFoodCore` re-asks it for its own callers.
  if (!isUsualBackfillDateAccepted(t, date)) return { kind: "invalid-date" };
  const via = date === t ? loggedVia : USUAL_BACKFILL;
  // Food first, in its own transaction, exactly as the Food tab runs it.
  const food =
    namedGroups.length > 0
      ? logUsualFoodCore(
          profileId,
          window,
          date,
          namedGroups,
          loggedVia,
          undefined,
          time,
          { notifyMessageId }
        )
      : ({ kind: "nothing-to-log" } as const);
  const groups = food.kind === "logged" ? food.groups : [];

  // The dose half re-derived AFTER the food write, which is the only correct order:
  // a `with_food` condition is not evaluated here, but the ledger the next reader sees
  // must already hold the servings this same tap wrote.
  const pending = new Map(
    getPendingRoutineDoses(profileId, window, date).map((d) => [d.doseId, d])
  );
  // WHICH WRITER (#4305). One question, asked once for the whole bundle, because the
  // day is the same for every dose in it. Inside the stale-tap window nothing moves.
  const dated = !isDoseDateAccepted(t, date);
  const tz = getTimezone(profileId);
  const doses: UsualRoutineDoseResult[] = [];
  for (const doseId of namedDoseIds) {
    const offered = pending.get(doseId);
    // Not in the standing bundle: forged, replayed, retired, paused, already resolved,
    // or another profile's. Silently outside the write — reporting it would leak
    // whether the id exists.
    if (!offered) continue;
    doses.push({
      doseId,
      name: offered.name,
      outcome: dated
        ? datedDoseWrite(profileId, tz, date, offered, via)
        : // markDoseTaken is idempotent per (dose, date) and refuses a retired dose or
          // a paused item on its own terms. Its answer is carried, never assumed.
          //
          // A PAST-DAY TAP STATES NO INTAKE TIME (#4428) — explicit null, exactly as the
          // recent-past day switcher passes and as the FOOD half of this same bundle
          // records a null eating instant. `undefined` here means "stamp now", which on
          // a dated bundle wrote an administration instant sitting on a different day
          // from the row it was filed under; the pair rule the rest of the model turns
          // on says an instant outside its own row's day is corruption, not precision.
          markDoseTaken(
            profileId,
            doseId,
            offered.itemId,
            date,
            via,
            date === t ? undefined : null,
            notifyMessageId
          ),
    });
  }

  if (groups.length === 0 && doses.length === 0)
    return { kind: "nothing-to-log" };
  return { kind: "logged", date, window, groups, doses };
}

// ── THE DATED BUNDLE'S AUDIT ROW (#4118/#4306) ───────────────────────────────
//
// Writing several servings and several dose confirms onto a day somebody has already
// lived through is a retroactive claim about what happened, and where a caregiver files
// one it is a claim about somebody else — so it is audited, exactly as `logHistoricalDose`
// is (#1933's reasoning). A contemporaneous tap is ordinary use and stays unaudited: the
// ledger rows are their own record.
//
// ONE SPELLING, TWO SURFACES. The web action and the Telegram handler both call this, so
// "the chat writes the same row the web path writes" (#4306's ruling) is structural
// rather than a thing two call sites have to keep agreeing about. The date test lives in
// here for the same reason — half a rule in two places is how they drift.
//
// PHI: target = the meal window, detail = the affected date. Identifiers and dates only.
export function recordUsualBackfillAudit(
  // The acting login. Null is a real answer — a chat whose binding no longer names one —
  // and `recordAudit` stores it, because a row that says WHAT happened to WHOSE data
  // without a name is still the trail; dropping the row would be the hole this closes.
  loginId: number | null,
  profileId: number,
  outcome: UsualRoutineOutcome,
  todayStr: string
): void {
  if (outcome.kind !== "logged" || outcome.date === todayStr) return;
  recordAudit({
    loginId,
    profileId,
    action: AUDIT_ACTIONS.usualBackfill,
    target: outcome.window,
    detail: outcome.date,
  });
}
