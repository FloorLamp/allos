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
// ── ALWAYS TODAY ─────────────────────────────────────────────────────────────
//
// No date crosses the wire. `logUsualFoodCore` resolves `today(profileId)` itself and
// this core resolves the same day for the dose half, so neither path can backfill.
//
// ── AND IT CHANGES NOTHING ELSE ──────────────────────────────────────────────
//
// No obligation is written (obligation is declared only, forever — #2419). No
// situation state moves. Nothing is pushed, no finding is raised, no dedupe key is
// minted, no cadence row is touched. Adherence moves exactly where dueness already
// existed, as if each row had been tapped by hand.

import { today } from "./db";
import { logUsualFoodCore, type UsualFoodLogged } from "./food-usual-write";
import type { FoodSlot } from "./food-slot";
import { markDoseTaken } from "./queries/intake/adherence";
import { getPendingRoutineDoses } from "./queries/usual-routine";
import type { DoseTakenOutcome } from "./types";

// What one named dose actually did. `outcome` is `markDoseTaken`'s own typed answer,
// carried out unflattened so the surface can say "3 taken, 1 already logged" rather
// than a bare count — the composed answer may never claim more than was written.
export interface UsualRoutineDoseResult {
  doseId: number;
  name: string;
  outcome: DoseTakenOutcome;
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
  | { kind: "nothing-to-log" };

// A dose confirm that actually moved the ledger. `logged-off-day` counts: the row was
// written and supply moved; only the framing differs (#1602).
export function usualRoutineDoseLogged(outcome: DoseTakenOutcome): boolean {
  return outcome === "logged" || outcome === "logged-off-day";
}

// Log the still-offered half of `namedGroups` into `window`, then confirm the
// still-pending half of `namedDoseIds`, on the profile's today.
//
// Both named lists are UPPER BOUNDS on the write and never an instruction to write
// outside the offer that currently stands.
export function logUsualRoutineCore(
  profileId: number,
  window: FoodSlot,
  namedGroups: readonly string[],
  namedDoseIds: readonly number[]
): UsualRoutineOutcome {
  const date = today(profileId);
  // Food first, in its own transaction, exactly as the Food tab runs it.
  const food =
    namedGroups.length > 0
      ? logUsualFoodCore(profileId, window, namedGroups)
      : ({ kind: "nothing-to-log" } as const);
  const groups = food.kind === "logged" ? food.groups : [];

  // The dose half re-derived AFTER the food write, which is the only correct order:
  // a `with_food` condition is not evaluated here, but the ledger the next reader sees
  // must already hold the servings this same tap wrote.
  const pending = new Map(
    getPendingRoutineDoses(profileId, window, date).map((d) => [d.doseId, d])
  );
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
      // markDoseTaken is idempotent per (dose, date) and refuses a retired dose or a
      // paused item on its own terms. Its answer is carried, never assumed.
      outcome: markDoseTaken(profileId, doseId, offered.itemId, date),
    });
  }

  if (groups.length === 0 && doses.length === 0)
    return { kind: "nothing-to-log" };
  return { kind: "logged", date, window, groups, doses };
}
