// Auth-blind write core for the food-group serving log (issues #579, #682). Takes
// profileId first and never imports lib/auth — the profileId-first + lib-write-core
// convention: both the `logFoodServing` Server Action (web one-tap bar) and the
// Telegram button handler (handleFoodLog) call this, so the ingestion path is one
// computation regardless of surface. The auth gate stays entirely in the action.
//
// One serving = one row per (profile, date, group_key) whose `servings` count is
// incremented; the keyed upsert is idempotent-friendly. group_key is validated
// against the curated catalog so a forged/stale slug (a tampered Telegram token, a
// retired group) lands nothing and is answered honestly by the caller.
//
// THE COUNTER ARITHMETIC IS NOT IN THIS FILE ANY MORE (#2037). Logging, undoing,
// correcting and re-stamping a serving all move the same `food_log` day counter, and
// this file used to spell the additive upsert / guarded decrement / drop-at-zero /
// authoritative re-select sequence out once per operation. They now all call the shared
// day-counter ledger (lib/day-counter-ledger.ts), so "what a serving does to the day's
// count" has exactly one implementation and a fifth operation cannot invent a fifth
// spelling of it. Everything else here — catalog canonicalization, the event ledger the
// counter rides with, meal-window derivation, the typed outcomes — is unchanged.

import { db, writeTx } from "./db";
import { now as clockNow, instantNow } from "./clock";
import { foodDayCounter } from "./day-counter-ledger-db";
import { acceptEatenAt } from "./food-eating-time";
import { isRealIsoDate, utcInstant, zonedDateParts } from "./date";
import { canonicalFoodGroup } from "./food-groups";
import { type FoodSlot } from "./food-slot";
import { foodSlotForProfileEvent } from "./profile-food-slot";
import { getTimezone } from "./settings";
import { isProteinNudgeKey } from "./protein-nudge";
import { burstFrom, type TapEvent } from "./correction-time";
import { captureDelete } from "./undo-delete-db";

// Where an event's eating instant came from (issue #2019, migration 154). `tap` is the
// button's own contract — "I'm eating now" — which is a measurement with known error,
// not a guess; `stated` is a human answer, whether a correction chip, the picker, or a
// web statement. A NULL column is the third and most common answer for history: nobody
// said, and nothing invented one.
export type FoodTimeSource = "tap" | "stated";

// The eating-time half of a serving write. Optional throughout: a caller with no
// statement to make omits it and the row keeps a NULL `eaten_at`, because defaulting a
// backfill to now would reintroduce the guess under a more authoritative name.
export interface FoodEatingTime {
  // ISO-8601 UTC instant the serving was eaten.
  eatenAt: string;
  source: FoodTimeSource;
}

// The typed result of a serving write, so a Telegram tap answers from what ACTUALLY
// happened rather than unconditionally confirming (the markDoseTaken contract, #232):
//   logged        — a serving was recorded; `servings` is the group's new total for the day.
//   unknown-group  — the slug isn't in the catalog (forged/stale token); nothing written.
export type FoodLogOutcome =
  | {
      kind: "logged";
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    }
  | { kind: "unknown-group" };

// The typed result of an undo (issue #748 item 5): a serving was removed and
// `servings` is the group's REMAINING daily total (0 once the row is dropped), or the
// slug isn't in the catalog. Undo is idempotent — undoing a group with nothing logged
// is a no-op that reports 0.
export type FoodUndoOutcome =
  | {
      kind: "undone";
      servings: number;
      mealSlot?: FoodSlot;
      mealServings?: number;
    }
  | { kind: "unknown-group" };

function mealServingCount(
  profileId: number,
  slug: string,
  date: string,
  mealSlot: FoodSlot
): number {
  const events = db
    .prepare(
      `SELECT logged_at, meal_slot, eaten_at FROM food_log_events
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .all(profileId, date, slug) as {
    logged_at: string;
    meal_slot: FoodSlot | null;
    eaten_at: string | null;
  }[];
  return events.filter(
    (event) =>
      foodSlotForProfileEvent(
        profileId,
        event.logged_at,
        event.meal_slot,
        event.eaten_at
      ) === mealSlot
  ).length;
}

// Log one serving of a food group on a day. Upserts the day's row, incrementing its
// servings, and returns the group's resulting daily total. Single IMMEDIATE
// transaction (#468) so the insert + the count read see one consistent state even
// under a concurrent web/Telegram tap on the same group.
export function logFoodServingCore(
  profileId: number,
  group: string,
  date: string,
  // The tap instant (an ISO-8601 UTC string), appended to the food_log_events ledger
  // (#950). Defaults to NOW and always remains the audit/tap time. `mealSlot`, when
  // supplied, separately records the consumed window for an honest backfill; callers
  // without an explicit meal retain the legacy timestamp-derived behavior. The instant
  // remains injectable so tests can seed a specific legacy slot.
  loggedAt: string = instantNow(),
  mealSlot?: FoodSlot,
  // WHEN IT WAS EATEN (#2019) — a separate fact from `loggedAt`, which stays the tap
  // stamp migration 056 froze. The Telegram button passes its own tap instant with
  // source `tap`, because that button's declared contract IS "I'm eating now"; the web
  // bar passes nothing unless the user states a time, so a backfill records no eating
  // time rather than a confident wrong one.
  time?: FoodEatingTime
): FoodLogOutcome {
  // Persist the canonical slug, not the raw input (#883): the matcher accepts
  // case/punctuation variants, but downstream readers compare group_key exactly.
  const slug = canonicalFoodGroup(group);
  if (slug === null) return { kind: "unknown-group" };
  return writeTx(() => {
    const servings = foodDayCounter.bump(profileId, date, [slug], 1);
    // Append the per-tap event in the SAME transaction (#950): the counter and its
    // ledger see one consistent state, so a reader can never observe a bumped count
    // with no matching event (or vice versa). Additive — the counter row above is
    // byte-identical to the pre-ledger write.
    db.prepare(
      `INSERT INTO food_log_events
         (profile_id, group_key, date, logged_at, meal_slot, eaten_at, time_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      slug,
      date,
      loggedAt,
      mealSlot ?? null,
      time?.eatenAt ?? null,
      time?.source ?? null
    );
    return {
      kind: "logged",
      servings,
      ...(mealSlot ? { mealSlot } : {}),
      ...(mealSlot
        ? { mealServings: mealServingCount(profileId, slug, date, mealSlot) }
        : {}),
    };
  });
}

// Undo one serving of a food group on a day (issue #748 item 5): decrement the day's
// row and drop it when it would hit zero, so a fully-undone group leaves no stray row.
// Single IMMEDIATE transaction (#468) — the decrement, the zero-cleanup DELETE, and the
// remaining-count read see one consistent state under a concurrent web/Telegram tap. An
// auth-blind core next to logFoodServingCore so a future Telegram "undo" button reuses
// the same computation rather than duplicating the two-statement sequence.
export function undoFoodServingCore(
  profileId: number,
  group: string,
  date: string,
  mealSlot?: FoodSlot
): FoodUndoOutcome {
  // Canonicalize so undo targets the same row a canonical log wrote (#883).
  const slug = canonicalFoodGroup(group);
  if (slug === null) return { kind: "unknown-group" };
  return writeTx(() => {
    const current = foodDayCounter.total(profileId, date, [slug]);
    if (current <= 0)
      return {
        kind: "undone",
        servings: 0,
        ...(mealSlot ? { mealSlot, mealServings: 0 } : {}),
      };

    const candidates = db
      .prepare(
        `SELECT id, logged_at, meal_slot, eaten_at FROM food_log_events
          WHERE profile_id = ? AND date = ? AND group_key = ?
          ORDER BY logged_at DESC, id DESC`
      )
      .all(profileId, date, slug) as {
      id: number;
      logged_at: string;
      meal_slot: FoodSlot | null;
      eaten_at: string | null;
    }[];
    const event = mealSlot
      ? candidates.find(
          (candidate) =>
            foodSlotForProfileEvent(
              profileId,
              candidate.logged_at,
              candidate.meal_slot,
              candidate.eaten_at
            ) === mealSlot
        )
      : candidates[0];

    // A slot-scoped undo may only remove a serving visible in that meal. This keeps
    // a Morning minus from silently deleting Dinner. Legacy counter-only history has
    // no assignable meal and therefore remains daily-only.
    if (mealSlot && !event)
      return {
        kind: "undone",
        servings: current,
        mealSlot,
        mealServings: 0,
      };

    const servings = foodDayCounter.unbump(profileId, date, [slug], 1);
    // Pop the chosen ledger event alongside the counter decrement (#950), one tx.
    // Default callers remove the newest event; meal-aware callers remove the newest
    // event in that meal. A pre-ledger counter row has no event to pop, which remains
    // a tolerated "popless decrement" for default callers.
    if (event) {
      db.prepare(
        `DELETE FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      ).run(event.id, profileId);
    }
    const removedSlot =
      mealSlot && event
        ? foodSlotForProfileEvent(
            profileId,
            event.logged_at,
            event.meal_slot,
            event.eaten_at
          )
        : undefined;
    return {
      kind: "undone",
      servings,
      ...(removedSlot ? { mealSlot: removedSlot } : {}),
      ...(mealSlot
        ? { mealServings: mealServingCount(profileId, slug, date, mealSlot) }
        : {}),
    };
  });
}

// ---- Correction (issue #1934) ----

// Where one ledger event SITS after a write, with the two authoritative counts that
// placement owns: the day counter for its (date, group) and the ledger tally for its
// (date, group, window). An edit answers with the placement BEFORE and the placement
// AFTER, both re-read post-write, so the surface reconciles its optimistic counts from
// the server rather than re-deriving a move client-side (the #748 item 2 discipline).
export interface FoodEventPlacement {
  date: string;
  groupKey: string;
  mealSlot: FoodSlot;
  // food_log servings for (profile, date, groupKey) AFTER the write. 0 once the row
  // is dropped.
  servings: number;
  // food_log_events count for (profile, date, groupKey) whose derived window is
  // `mealSlot`, AFTER the write.
  mealServings: number;
}

// The typed result of a correction:
//   updated        — the event moved; `from`/`to` carry both placements' post-write counts.
//   not-found      — no such event for this profile (a forged/stale id, or another
//                    profile's row — the statement is id + profile_id scoped).
//   unknown-group  — the requested group isn't in the catalog; nothing written.
//   invalid-date   — the requested date isn't a real calendar date; nothing written.
//   invalid-eaten-at — the requested eating instant fails the acceptEatenAt rule against
//                    the FINAL date of the patch (off the row's own day, or meaningfully
//                    future); nothing written. Enforced HERE, at the auth-blind boundary,
//                    beside invalid-date — the day rule is the ledger's own invariant,
//                    not a courtesy of whichever action called it.
//   not-correctable — the row is the reserved `__protein__` ranking event, which is not
//                    a food-group serving: its truth is the protein_log grams total, and
//                    re-keying it onto a catalog group would mint a serving from a shake.
export type FoodEventEditOutcome =
  | {
      kind: "updated";
      id: number;
      from: FoodEventPlacement;
      to: FoodEventPlacement;
    }
  | { kind: "not-found" }
  | { kind: "unknown-group" }
  | { kind: "invalid-date" }
  | { kind: "invalid-eaten-at" }
  | { kind: "not-correctable" };

// The post-write placement of one (date, group, window) coordinate. Read INSIDE the
// caller's transaction so `from` and `to` describe one consistent state.
function placementOf(
  profileId: number,
  date: string,
  groupKey: string,
  mealSlot: FoodSlot
): FoodEventPlacement {
  return {
    date,
    groupKey,
    mealSlot,
    servings: foodDayCounter.total(profileId, date, [groupKey]),
    mealServings: mealServingCount(profileId, groupKey, date, mealSlot),
  };
}

// Correct one already-logged serving: its food group, its day, its meal window
// (issue #1934), and/or its eating instant (issue #2227). The one-tap surfaces got
// create + delete and never got correction, and delete-and-re-log is NOT equivalent —
// a re-log stamps the CURRENT instant and window, so "logged last night's dinner this
// morning" cannot be repaired faithfully.
//
// The event ledger and the food_log day counter are ONE fact in two shapes, so the
// counter MOVES with the event in the same IMMEDIATE transaction: a (date, group) change
// decrements the old counter (dropping the row at zero, the undoFoodServingCore
// discipline) and increments the new one. Exactly one serving exists throughout — the
// derived reads (slot tallies, the day's counts, the weekly frequency-target progress)
// all recompute live off these two tables, so a move can never double-count.
//
// `logged_at` is deliberately NOT edited: it is the audit/tap instant, and the MEANINGFUL
// grain is the window, which `meal_slot` asserts explicitly. An event left without an
// explicit window keeps its NULL and therefore keeps deriving from `logged_at` — a
// correction never silently freezes a legacy row's window.
export function updateFoodLogEventCore(
  profileId: number,
  eventId: number,
  patch: {
    groupKey?: string;
    date?: string;
    mealSlot?: FoodSlot;
    // The eating instant (#2227), with THREE states: ABSENT leaves the row's alone
    // (the house convention — an omitted patch field is not a change), NULL clears it
    // back to "nobody said" (`eaten_at` NULL + `time_source` NULL), and a Date states
    // it (`time_source` = 'stated'). Validated against the FINAL date of the patch —
    // an instant off the row's own day answers `invalid-eaten-at` and writes nothing.
    eatenAt?: Date | null;
  }
): FoodEventEditOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT group_key, date, logged_at, meal_slot, eaten_at, time_source
           FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as
      | {
          group_key: string;
          date: string;
          logged_at: string;
          meal_slot: FoodSlot | null;
          eaten_at: string | null;
          time_source: FoodTimeSource | null;
        }
      | undefined;
    if (!row) return { kind: "not-found" as const };
    if (isProteinNudgeKey(row.group_key))
      return { kind: "not-correctable" as const };

    // Canonicalize only a REQUESTED group (#883). The stored key is used verbatim for
    // the old-counter decrement — a retired slug must still be able to give its serving
    // back, which is exactly the repair someone reaches for.
    const nextGroup =
      patch.groupKey === undefined
        ? row.group_key
        : canonicalFoodGroup(patch.groupKey);
    if (nextGroup === null) return { kind: "unknown-group" as const };
    const nextDate = patch.date ?? row.date;
    if (!isRealIsoDate(nextDate)) return { kind: "invalid-date" as const };
    const nextSlot = patch.mealSlot ?? row.meal_slot;

    // A STATED instant must satisfy the same acceptEatenAt rule every other eaten_at
    // write goes through — judged against the FINAL date, so a patch that moves the day
    // and states an hour is checked against the day the row will actually sit on. What
    // a refusal costs stays the caller's posture: the correction action surfaces it as
    // an error the user sees, never a silent clear (#2227's inversion of the log path).
    if (
      patch.eatenAt != null &&
      acceptEatenAt(patch.eatenAt, getTimezone(profileId), nextDate, clockNow()) ===
        null
    )
      return { kind: "invalid-eaten-at" as const };
    // The eating instant the row carries AFTER this patch; `time_source` travels with
    // it (a stated instant is 'stated', a cleared one is honest NULL, an untouched one
    // keeps whatever contract wrote it — a Telegram 'tap' stays a tap).
    const nextEatenAt =
      patch.eatenAt === undefined
        ? row.eaten_at
        : patch.eatenAt === null
          ? null
          : utcInstant(patch.eatenAt);
    const nextTimeSource: FoodTimeSource | null =
      patch.eatenAt === undefined
        ? row.time_source
        : patch.eatenAt === null
          ? null
          : "stated";

    const fromSlot = foodSlotForProfileEvent(
      profileId,
      row.logged_at,
      row.meal_slot,
      row.eaten_at
    );
    // Derived from the NEXT eating instant, not the one being replaced: the returned
    // `to` placement is what the bar adopts for its counts, so a patch that sets
    // `eatenAt` without `mealSlot` must answer with the window the NEW instant lands in.
    const toSlot = foodSlotForProfileEvent(
      profileId,
      row.logged_at,
      nextSlot,
      nextEatenAt
    );

    if (nextDate !== row.date || nextGroup !== row.group_key) {
      // The move is one unbump plus one bump on the shared ledger, so the drop-at-zero
      // on the vacated coordinate and the create-on-first on the new one are the same
      // two rules every other serving write obeys. A time-only patch changes neither
      // coordinate and therefore performs neither (#2227 constraint 4).
      foodDayCounter.unbump(profileId, row.date, [row.group_key], 1);
      foodDayCounter.bump(profileId, nextDate, [nextGroup], 1);
    }
    db.prepare(
      `UPDATE food_log_events
          SET group_key = ?, date = ?, meal_slot = ?, eaten_at = ?, time_source = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      nextGroup,
      nextDate,
      nextSlot,
      nextEatenAt,
      nextTimeSource,
      eventId,
      profileId
    );

    return {
      kind: "updated" as const,
      id: eventId,
      from: placementOf(profileId, row.date, row.group_key, fromSlot),
      to: placementOf(profileId, nextDate, nextGroup, toSlot),
    };
  });
}

// ---- Row-scoped removal (issue #1963) ----

// The typed result of removing ONE named serving:
//   deleted       — the event is gone; `vacated` carries the post-write counts for the
//                   coordinate it occupied, so a surface SETS from the server rather
//                   than decrementing locally (the same discipline as the correction's
//                   `from`/`to`).
//   not-found     — no such event for this profile (a forged/stale id, or another
//                   profile's row — the statements are id + profile_id scoped).
//   not-deletable — the row is the reserved `__protein__` ranking event. Same refusal
//                   the correction path answers (#1951), for the same reason: its truth
//                   is the protein_log grams total, and popping the ledger row would
//                   remove the ranking participant while the grams it stands for
//                   silently survived. Protein is removed from the protein total.
export type FoodEventDeleteOutcome =
  | {
      kind: "deleted";
      id: number;
      vacated: FoodEventPlacement;
      // The undo token (#2038). Every other "remove one logged event" path offers one;
      // this one used to be permanent, which made the PRECISE control the unforgiving
      // one next to a group "−" you could just tap again.
      undoId: number;
    }
  | { kind: "not-found" }
  | { kind: "not-deletable" };

// Remove one ALREADY-NAMED logged serving (issue #1963).
//
// The group-scoped undo (undoFoodServingCore) picks its victim by `logged_at DESC` — the
// newest tap in the meal. That was coherent while servings within a (day, group, window)
// were fungible, and #1934 ended it: a correction gives a row a user-asserted `meal_slot`
// while deliberately PRESERVING its tap instant, so a serving moved INTO a window is not
// necessarily the newest thing in it. The ⋯ row menu already asserts a per-row identity;
// this is the removal that honours it. `bump(-1)` is unchanged and stays the quick
// group-level control.
//
// The ledger row and the food_log day counter are ONE fact in two shapes, so the counter
// moves with the row in the SAME IMMEDIATE transaction and the counter row is dropped at
// zero — the updateFoodLogEventCore/undoFoodServingCore discipline, not a second pattern.
//
// UNDOABLE since #2038. The removal goes through `captureDelete("food-serving")`, which
// holds the capture, the event delete and the counter decrement in that one transaction;
// its registry entry declares `food_log.servings` as the day COUNTER this row is one tick
// of, so undo increments it back — re-creating the counter row from the captured snapshot
// only when this serving was the day's last. `food_log_events` remains outside
// STATEFUL_WRITE_TABLES: logging a serving is still the ADDITIVE case that registry's own
// criterion names, and undo coverage is a different question from a gated transition.
export function deleteFoodLogEventCore(
  profileId: number,
  eventId: number
): FoodEventDeleteOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT group_key, date, logged_at, meal_slot, eaten_at
           FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as
      | {
          group_key: string;
          date: string;
          logged_at: string;
          meal_slot: FoodSlot | null;
          eaten_at: string | null;
        }
      | undefined;
    if (!row) return { kind: "not-found" as const };
    if (isProteinNudgeKey(row.group_key))
      return { kind: "not-deletable" as const };

    // The window the serving was COUNTED in, derived before the row is popped — the
    // vacated placement has to name the coordinate the tallies actually lose.
    const slot = foodSlotForProfileEvent(
      profileId,
      row.logged_at,
      row.meal_slot,
      row.eaten_at
    );

    // The captured event's own stored key drives the counter decrement (never a
    // canonicalized one): a retired slug must still be able to give its serving back,
    // which is exactly the repair someone reaches for. The registry's counter spec keys
    // on (date, group_key) read off the captured row, so that holds through undo too.
    const undoId = captureDelete("food-serving", profileId, eventId);
    if (undoId == null) return { kind: "not-found" as const };

    return {
      kind: "deleted" as const,
      id: eventId,
      undoId,
      vacated: placementOf(profileId, row.date, row.group_key, slot),
    };
  });
}

// ---- Eating-time correction (issue #2019) ----

// One ledger row as the correction offer reads it: the row id, the immutable tap stamp
// (burst identity and every chip offset are computed from THIS, never from the corrected
// instant), and a display label for a lone-tap row.
export interface FoodTapRow extends TapEvent {
  groupKey: string;
}

// The typed result of a burst re-stamp:
//   restamped — `count` rows now carry a stated eating instant; `movedDays` of them
//               also changed calendar day, taking their serving with them.
//   no-burst  — the anchor row is gone or belongs to another profile (a forged or
//               long-stale token). Nothing is written and the caller says so rather
//               than confirming a correction that did not happen.
//   out-of-range — the resolver refused at least one row (a chip that would walk the
//               burst past the floor, #2206). ALL-OR-NOTHING: a burst is one error, so
//               moving part of it would leave the ledger in a state no tap asked for.
export type FoodRestampOutcome =
  | { kind: "restamped"; count: number; movedDays: number }
  | { kind: "no-burst" }
  | { kind: "out-of-range" };

// Re-stamp a whole burst's eating time (issue #2019).
//
// `resolve` maps each row — its immutable tap stamp AND the instant it currently stands
// at — to the instant it should now carry, which is what keeps a burst's internal spread
// intact: four servings tapped across six minutes stay six minutes apart after a chip
// instead of collapsing onto one instant. The picker's resolver ignores its argument and
// returns one absolute instant for the burst, which is the correct shape there — the user
// answered for the meal, not per serving. Returning null REFUSES the whole write.
//
// REPEAT TAPS COMPOSE (#2206). The chip resolver counts back from `eaten_at`, so a second
// −1h means two hours back rather than landing on the same instant — the row now SHOWS
// its result, and "tap again to go further" is the only reading a visibly-moving value
// supports. The compose is race-safe without any versioning of its own: every tap reads
// its base inside this IMMEDIATE transaction, so a second callback arriving against the
// same burst reads what the first one committed. What used to be idempotence is now the
// resolver's floor — see `chipTarget`.
//
// CROSS-MIDNIGHT RE-DATING FALLS OUT. `eaten_at` decides the row's calendar day, so a
// correction that crosses local midnight moves the event's `date` AND the `food_log`
// counter it belongs to, in the SAME IMMEDIATE transaction — the ledger row and the day
// counter are one fact in two shapes (the updateFoodLogEventCore discipline), so exactly
// one serving exists throughout and the day tallies, slot tallies and weekly-target
// progress all recompute live off the moved pair. This is what turns "last night's dinner
// logged after midnight" from a dead end into a tap plus one chip.
//
// THE RESERVED `__protein__` ROW is re-stamped but never re-dated. It is a ranking event,
// not a serving: its truth is the `protein_log` grams total, keyed by DAY, and the ledger
// row carries no grams to move with it. So its instant gets corrected — which is what
// makes protein DISTRIBUTION computable, the actual recommendation — while its day stays
// where the grams are. Moving one without the other is the corruption; moving neither
// while still fixing the instant is the honest limit of a grams-less row.
export function restampFoodEventsCore(
  profileId: number,
  fromEventId: number,
  resolve: (row: { tapAt: string; statedAt: string | null }) => Date | null
): FoodRestampOutcome {
  return writeTx(() => {
    // The burst is re-derived from the LEDGER at tap time, from the anchor id forward —
    // the token carries an id only, so which rows a chip moves is never a memory of what
    // some earlier keyboard rendered.
    const rows = db
      .prepare(
        `SELECT id, group_key, date, logged_at, eaten_at FROM food_log_events
          WHERE profile_id = ? AND id >= ?
          ORDER BY logged_at, id
          LIMIT 200`
      )
      .all(profileId, fromEventId) as {
      id: number;
      group_key: string;
      date: string;
      logged_at: string;
      eaten_at: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const burst = burstFrom(
      rows.map((r) => ({
        id: r.id,
        tapAt: r.logged_at,
        statedAt: r.eaten_at,
        label: r.group_key,
      })),
      fromEventId
    );
    if (!burst) return { kind: "no-burst" as const };

    // RESOLVE EVERY ROW BEFORE WRITING ANY (#2206). One refusal refuses the burst, so a
    // chip that has run out of room cannot half-move a meal.
    const targets = new Map<number, Date>();
    for (const id of burst.ids) {
      const row = byId.get(id);
      if (!row) continue;
      const instant = resolve({ tapAt: row.logged_at, statedAt: row.eaten_at });
      if (!instant) return { kind: "out-of-range" as const };
      targets.set(id, instant);
    }

    const tz = getTimezone(profileId);
    let movedDays = 0;
    for (const id of burst.ids) {
      const row = byId.get(id);
      const instant = targets.get(id);
      if (!row || !instant) continue;
      const eatenAt = utcInstant(instant);
      const nextDate = zonedDateParts(tz, instant).date;
      const reDate = nextDate !== row.date && !isProteinNudgeKey(row.group_key);
      if (reDate) {
        // Same unbump/bump pair as the correction path, on the day axis instead of the
        // group axis — one serving exists throughout.
        foodDayCounter.unbump(profileId, row.date, [row.group_key], 1);
        foodDayCounter.bump(profileId, nextDate, [row.group_key], 1);
        movedDays++;
      }
      db.prepare(
        `UPDATE food_log_events
            SET eaten_at = ?, time_source = 'stated', date = ?
          WHERE id = ? AND profile_id = ?`
      ).run(eatenAt, reDate ? nextDate : row.date, id, profileId);
    }
    return { kind: "restamped" as const, count: burst.ids.length, movedDays };
  });
}
