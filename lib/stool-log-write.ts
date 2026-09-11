// Auth-blind write core for the stool ledger (issue #5872) — the food-log-write /
// substance-log-write pattern re-instantiated for `stool_events`. Takes profileId first
// and never imports lib/auth (#319): the Server Actions in app/(app)/stool-actions.ts
// and the offline replay's `logBristolStool` are the callers, and the auth gate stays
// entirely at the request boundary.
//
// A STOOL IS AN EVENT WITH AN OPTIONAL TYPE (the owner's 2026-09-11 ruling). Two things
// follow, and they are the whole reason this file exists rather than another
// `metric_samples` write:
//
//   • THE TYPE IS NULLABLE. "I had a poop this morning but didn't see what form" is a
//     recordable observation. `logStoolCore` takes `type: BristolType | null` and a null
//     is a state, not a missing value.
//
//   • THE LEDGER IS APPEND-ONLY. Two movements are two rows, always — including two in
//     the same minute. The old store upserted on the samples natural key (profile,
//     metric, source, origin, started_at), so a second movement STATED at a minute
//     already recorded overwrote the first. That is data loss on medical data for
//     exactly the people who log stools often. There is no natural key here and no
//     ON CONFLICT clause; an insert is an insert.
//
// AND THE UNSTATED INSTANT IS NULL, NEVER THE CLOCK. The old write stamped an unstated
// tap at the wall clock, so the row could not tell "happened at 7:41" from "filed at
// 7:41" and the record printed the filing minute in the stated grammar. `occurred_at`
// NULL with `time_source` NULL means nobody said when, `recorded_at` keeps the tap
// instant, and the record reads "logged 7:41am" (#5618 ruling 6 for the other-day
// spelling). Nothing in this file reads the clock to fill `occurred_at`.
//
// NEVER GAMIFIED: these writes never touch `activities`, so the milestone/streak
// machinery stays structurally blind to the domain, exactly as the substance ledger is.

import { db, today, writeTx } from "./db";
import { instantNow, now as clockNow } from "./clock";
import { isRealIsoDate, utcInstant } from "./date";
import { isBristolType } from "./bristol-stool";
import { getTimezone } from "./settings";
import {
  judgeStatedAt,
  statedInstantOnDate,
  type StatedTimeRefusal,
} from "./stated-time";
import { captureDelete } from "./undo-delete-db";
import { STOOL_MOVEMENT_LOG } from "./log-manifest";

/** A member of the Bristol scale. The range is the schema's; this names the vocabulary. */
export type BristolType = number;

/**
 * The typed result of a log.
 *   logged        — an occurrence was recorded; `eventId` is its address and
 *                   `statedTimeRefused` says the minute did not land when the gate
 *                   refused it (a NOTICE, never a failure — #4425's body-metric
 *                   contract: losing the stated minute is cosmetic, losing the log is
 *                   not).
 *   invalid-date  — not a real past day (#4425's shared invariant); nothing written.
 *   invalid-type  — a value that names no Bristol type. `null` is not one of these:
 *                   null is "nobody saw", which is the whole point.
 */
export type StoolLogOutcome =
  | { kind: "logged"; eventId: number; statedTimeRefused?: StatedTimeRefusal }
  | { kind: "invalid-date" }
  | { kind: "invalid-type" };

/** The typed result of a correction, the sibling ledgers' shape. */
export type StoolEventEditOutcome =
  | { kind: "updated"; eventId: number; date: string }
  | { kind: "not-found" }
  | { kind: "invalid-date" }
  | { kind: "invalid-type" }
  | { kind: "invalid-stated-at"; reason: StatedTimeRefusal };

/**
 * RECORD ONE MOVEMENT.
 *
 * `type` is the Bristol type or NULL for an occurrence nobody saw the form of. `at` is
 * the profile-local wall clock the person STATED, or null when they stated none — and
 * null is where this core differs from the reading it replaces: it writes NULL, it does
 * not read the clock. A stated time is judged by the one shared gate (`judgeStatedAt`,
 * #2236) against the day it is filed on; a refusal costs the MINUTE and never the
 * observation, which is the log path's posture (the correction path's is the inverse
 * and lives below).
 */
export function logStoolCore(
  profileId: number,
  date: string,
  type: BristolType | null,
  at?: string | null,
  // The CAPTURE instant, canonical. Defaults to now; the offline replay supplies the
  // instant the tap actually happened at, which is a record stamp and never the
  // movement's own — see logBristolStool.
  recordedAt: string = instantNow()
): StoolLogOutcome {
  if (!isRealIsoDate(date) || date > today(profileId))
    return { kind: "invalid-date" };
  if (type !== null && !isBristolType(type)) return { kind: "invalid-type" };

  const tz = getTimezone(profileId);
  const stated = statedInstant(at ?? null, date, tz);
  if (stated.kind === "malformed") return { kind: "invalid-date" };

  return writeTx(() => {
    const inserted = db
      .prepare(
        `INSERT INTO stool_events
           (profile_id, date, recorded_at, occurred_at, time_source, type)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        recordedAt,
        stated.kind === "accepted" ? stated.at : null,
        stated.kind === "accepted" ? "stated" : null,
        type
      );
    return {
      kind: "logged" as const,
      eventId: Number(inserted.lastInsertRowid),
      ...(stated.kind === "refused"
        ? { statedTimeRefused: stated.reason }
        : {}),
    };
  });
}
// #4614: each core declares its own domain; `LOG_MANIFEST`'s cores column derives.
export const logStoolCoreDeclares = STOOL_MOVEMENT_LOG;

// The log path's stated-time resolution, in one place because the answer has three
// arms and the caller branches on all three. `malformed` is a shape the form boundary
// should already have refused; it is spelled out rather than folded into `unstated` so
// a crafted post cannot quietly become "nobody said when".
type StatedInstant =
  | { kind: "accepted"; at: string }
  | { kind: "refused"; reason: StatedTimeRefusal }
  | { kind: "unstated" }
  | { kind: "malformed" };

function statedInstant(
  hhmm: string | null,
  date: string,
  tz: string
): StatedInstant {
  if (!hhmm) return { kind: "unstated" };
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return { kind: "malformed" };
  const instant = statedInstantOnDate(date, hhmm, tz);
  if (!instant) return { kind: "malformed" };
  const verdict = judgeStatedAt(instant, tz, date, clockNow());
  return verdict.kind === "accepted"
    ? { kind: "accepted", at: utcInstant(instant) }
    : { kind: "refused", reason: verdict.reason };
}

/**
 * CORRECT ONE RECORDED MOVEMENT — re-type it, re-time it, re-file it onto another day,
 * or any combination. `correctSubstanceEventCore` / `updateFoodLogEventCore`'s
 * three-state patch convention, deliberately spelled the same way:
 *
 *   • an ABSENT field leaves the row's value alone;
 *   • `statedAt: null` clears the instant back to "nobody said";
 *   • a Date states it, landing as `occurred_at` + `time_source = 'stated'`.
 *
 * THE TYPE TAKES THE SAME THREE STATES, and both new halves matter: `type: 4` on a row
 * that carries none is the answer to "I saw it after all", and `type: null` on a typed
 * row clears it back to an occurrence nobody saw the form of. The old door could only
 * ever move a type between two members of the scale, because the store had no way to
 * hold the absence.
 *
 * The stated instant is judged against the FINAL date, so a correction that moves the
 * day and names an hour is checked against the day the row will actually sit on. A
 * refusal writes NOTHING and carries its reason: this is the correction posture, where
 * the statement IS the submission, and not the log path's "keep the row, drop the
 * minute".
 */
export function correctStoolEventCore(
  profileId: number,
  eventId: number,
  patch: { date?: string; statedAt?: Date | null; type?: BristolType | null }
): StoolEventEditOutcome {
  if (patch.type !== undefined && patch.type !== null && !isBristolType(patch.type))
    return { kind: "invalid-type" };
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT date, occurred_at, time_source, type
           FROM stool_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as
      | {
          date: string;
          occurred_at: string | null;
          time_source: string | null;
          type: number | null;
        }
      | undefined;
    if (!row) return { kind: "not-found" as const };

    const nextDate = patch.date ?? row.date;
    // THE REQUESTED DAY IS BOUNDED, NOT THE FINAL ONE (#4463's rule, in the food core's
    // own words): `nextDate` falls back to the stored date, so bounding that would make
    // a row already dated ahead — a restored capture, a legacy import — uncorrectable
    // in every direction including back into range.
    if (
      !isRealIsoDate(nextDate) ||
      (patch.date !== undefined && patch.date > today(profileId))
    )
      return { kind: "invalid-date" as const };

    if (patch.statedAt != null) {
      const verdict = judgeStatedAt(
        patch.statedAt,
        getTimezone(profileId),
        nextDate,
        clockNow()
      );
      if (verdict.kind !== "accepted")
        return { kind: "invalid-stated-at" as const, reason: verdict.reason };
    }
    const nextStatedAt =
      patch.statedAt === undefined
        ? row.occurred_at
        : patch.statedAt === null
          ? null
          : utcInstant(patch.statedAt);
    const nextTimeSource =
      patch.statedAt === undefined
        ? row.time_source
        : patch.statedAt === null
          ? null
          : "stated";

    db.prepare(
      `UPDATE stool_events
          SET date = ?, occurred_at = ?, time_source = ?, type = ?
        WHERE id = ? AND profile_id = ?`
    ).run(
      nextDate,
      nextStatedAt,
      nextTimeSource,
      patch.type === undefined ? row.type : patch.type,
      eventId,
      profileId
    );
    return { kind: "updated" as const, eventId, date: nextDate };
  });
}

/**
 * DELETE ONE RECORDED MOVEMENT, in the shape `useUndoableDelete` reads (#2642).
 *
 * Rooted on the EVENT and routed through `captureDelete`, so the Undo restores the row
 * — the `substance-use` delete's contract with no counter to give back, because this
 * ledger has no day counter: the count IS the rows.
 *
 * ONE AUTHORITY, AND NO PRE-READ (the review-of-#5290 rule the substance delete
 * carries): `captureDelete` opens its own `writeTx` and its first statement is the
 * identical `WHERE id = ? AND profile_id = ?`, answering null for a row that is absent
 * OR another profile's — which is the `undoId: null` below. Adding an existence probe
 * here would be a second copy of the profile boundary, in its own transaction.
 */
export function deleteStoolEventCore(
  profileId: number,
  eventId: number
): { undoId: number | null } {
  return { undoId: captureDelete("stool-event", profileId, eventId) };
}
