// DB INTEGRATION TIER — dose-edit lifecycle vs adherence history.
//
// Exercises the invariants that keep a supplement/medication EDIT from
// corrupting its adherence history and lets stale Telegram taps be answered
// honestly:
//
//   • markDoseTaken returns a DoseTakenOutcome (logged / already-taken /
//     already-skipped / stale-dose / inactive) instead of silently no-oping,
//     refuses retired doses and paused items, and snapshots the dose amount
//     onto the log. An already-resolved dose reports the status that ACTUALLY
//     stands (#280), so a stale cross-action tap (⏭ on a taken dose, ✅ on a
//     skipped one) — and the Telegram answer text rendered from it — can never
//     falsely confirm the other action.
//   • getSupplementDoses (the "current schedule" read every page/reminder
//     consumer goes through) excludes retired doses.
//   • The amount snapshot keeps history stable across a later dosage edit.
//   • The offline queue's replay rides those SAME cores (#1427) — there is no
//     offline-only dose writer — and its typed refusals (retired dose, PAUSED
//     item, an entry too old for the dose-log window) reach the user with a
//     reason instead of being reported as synced.
//
// The db singleton is redirected at a per-file temp DB by setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getSupplementDoses,
  getIntakeLogsForDate,
  getTakenDoseIds,
  getSkippedDoseIds,
  markDoseTaken,
  markDoseSkipped,
  escalationAckState,
} from "@/lib/queries";
import { shiftDateStr, utcSqlString, zonedWallTimeToUtc } from "@/lib/date";
import {
  tapAnswerText,
  tapSkipAnswerText,
} from "@/lib/notifications/callback-data";
import { getTimezone } from "@/lib/settings";
import { applyIntent } from "@/lib/offline/writes";
import {
  STALE_QUEUED_DOSE_REASON,
  type QueuedIntent,
} from "@/lib/offline/queue";

let seq = 0;

function seedProfileRow(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Dose P${++seq}`)
      .lastInsertRowid
  );
}

function seedItem(
  profileId: number,
  opts: { active?: number; quantityOnHand?: number | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, ?, 'supplement', 'daily', 'should', ?, 1)`
      )
      .run(
        profileId,
        `Item ${++seq}`,
        opts.active ?? 1,
        opts.quantityOnHand ?? null
      ).lastInsertRowid
  );
}

function seedDose(itemId: number, amount: string, retired = 0): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort, retired)
         VALUES (?, ?, 'morning', 'any', 0, ?)`
      )
      .run(itemId, amount, retired).lastInsertRowid
  );
}

function logRow(doseId: number, date: string) {
  return db
    .prepare(
      "SELECT amount, status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
    )
    .get(doseId, date) as { amount: string | null; status: string } | undefined;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

// Anchored on the app's real today: markDoseTaken/markDoseSkipped bound the
// token's date to a small window around today (issue #614), so a fixed calendar
// literal would drift out of that window as wall-clock time moves. Since #1427 the
// offline replay goes through those same cores, so it shares the window too.
const DATE = today(1);

// One queued offline intent, as the replay route hands it to applyIntent. A fresh
// idempotency key per call unless one is passed (replaying the SAME key is the
// exactly-once path, which must answer "duplicate").
function doseIntent(
  flow: "dose" | "skip-dose",
  doseId: number,
  opts: { date?: string; clientTakenAt?: string; key?: string } = {}
): QueuedIntent {
  const date = opts.date ?? DATE;
  return {
    key: opts.key ?? `dose-intent-${++seq}-${Date.now()}`,
    flow,
    date,
    capturedAt: new Date().toISOString(),
    payload: {
      doseId,
      ...(opts.clientTakenAt ? { clientTakenAt: opts.clientTakenAt } : {}),
    },
  };
}

function recordedAt(doseId: number, date: string): string | null {
  return (
    (
      db
        .prepare(
          "SELECT recorded_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .get(doseId, date) as { recorded_at: string | null } | undefined
    )?.recorded_at ?? null
  );
}

describe("markDoseTaken outcomes", () => {
  it("logs with an amount snapshot, decrements supply, and dedups the repeat", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("logged");
    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
    expect(onHand(itemId)).toBe(9);

    // Idempotent repeat: reported as already-taken, supply untouched.
    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe(
      "already-taken"
    );
    expect(onHand(itemId)).toBe(9);
  });

  it("refuses a retired dose as stale (nothing logged, no supply burn)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg", 1);

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("stale-dose");
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(onHand(itemId)).toBe(10);
  });

  it("refuses a deleted / cross-profile dose as stale", () => {
    const profileId = seedProfileRow();
    expect(markDoseTaken(profileId, 999_999, null, DATE)).toBe("stale-dose");

    // Another profile's dose id is indistinguishable from a deleted one.
    const other = seedProfileRow();
    const foreignDose = seedDose(seedItem(other), "5 mg");
    expect(markDoseTaken(profileId, foreignDose, null, DATE)).toBe(
      "stale-dose"
    );
    expect(logRow(foreignDose, DATE)).toBeUndefined();
  });

  it("refuses a paused item's dose as inactive", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { active: 0, quantityOnHand: 5 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("inactive");
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(onHand(itemId)).toBe(5);
  });

  it("keeps the logged amount frozen across a later dosage edit", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "500 mg");
    markDoseTaken(profileId, doseId, itemId, DATE);

    // Brand switch: the dose row's amount changes after the confirmation.
    db.prepare(
      "UPDATE intake_item_doses SET amount = '1000 mg' WHERE id = ?"
    ).run(doseId);

    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
  });
});

describe("retired doses and the current-schedule read", () => {
  it("getSupplementDoses excludes retired doses but keeps live ones", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const live = seedDose(itemId, "1000 mg");
    seedDose(itemId, "500 mg", 1);

    const ids = getSupplementDoses(profileId).map((d) => d.id);
    expect(ids).toEqual([live]);
  });

  it("a retired dose's history rows survive (no cascade)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "500 mg");
    markDoseTaken(profileId, doseId, itemId, DATE);

    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );
    expect(logRow(doseId, DATE)?.amount).toBe("500 mg");
  });
});

describe("markDoseSkipped outcomes (#232)", () => {
  it("writes a skipped log with NULL amount and leaves supply untouched", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe("skipped");
    const row = logRow(doseId, DATE);
    expect(row?.status).toBe("skipped");
    expect(row?.amount).toBeNull();
    // A skip consumes nothing — on-hand supply stays at 10.
    expect(onHand(itemId)).toBe(10);
    // A skipped dose is not "taken" but IS "skipped" for the resolved views.
    expect(getTakenDoseIds(profileId, DATE).has(doseId)).toBe(false);
    expect(getSkippedDoseIds(profileId, DATE).has(doseId)).toBe(true);
  });

  it("is idempotent and never overwrites an already-resolved dose", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    // First skip logs; a repeat reports the standing skip.
    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe("skipped");
    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe(
      "already-skipped"
    );

    // A stale ⏭ tap must NOT flip an already-TAKEN dose to skipped: taken first…
    const doseB = seedDose(itemId, "250 mg");
    expect(markDoseTaken(profileId, doseB, itemId, DATE)).toBe("logged");
    expect(onHand(itemId)).toBe(9);
    // …then a skip tap is refused, reporting the TAKEN log that stands (#280);
    // the taken row and the supply decrement both survive.
    expect(markDoseSkipped(profileId, doseB, itemId, DATE)).toBe(
      "already-taken"
    );
    expect(logRow(doseB, DATE)?.status).toBe("taken");
    expect(onHand(itemId)).toBe(9);
  });

  // The #280 regression pair: the DISPLAYED Telegram answer for a stale
  // cross-action tap must name the status that actually stands — asserting the
  // outcome enum alone let "Skipped ⏭" render over a taken log (and vice versa).
  it("a stale ⏭ tap on a TAKEN dose is never answered 'Skipped' (#280)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    // Dose marked taken out-of-band (web UI / another device)…
    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("logged");
    // …then the stale Telegram ⏭ button is tapped.
    const answer = tapSkipAnswerText(
      markDoseSkipped(profileId, doseId, itemId, DATE)
    );
    expect(answer).toMatch(/^Not skipped/);
    expect(answer).toMatch(/taken/i);
    expect(answer).not.toContain("Skipped ⏭");
    expect(logRow(doseId, DATE)?.status).toBe("taken");
  });

  it("a stale ✅ tap on a SKIPPED dose is never answered 'Logged' (#280)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseSkipped(profileId, doseId, itemId, DATE)).toBe("skipped");
    const answer = tapAnswerText(
      markDoseTaken(profileId, doseId, itemId, DATE)
    );
    expect(answer).toMatch(/^Not logged/);
    expect(answer).toMatch(/skipped/i);
    expect(answer).not.toContain("Logged ✅");
    // The skip stands untouched, and no supply was burned by the stale ✅.
    expect(logRow(doseId, DATE)?.status).toBe("skipped");
    expect(onHand(itemId)).toBe(10);
  });

  it("refuses a retired dose (stale) and a paused item (inactive)", () => {
    const profileId = seedProfileRow();
    const retiredItem = seedItem(profileId, { quantityOnHand: 5 });
    const retired = seedDose(retiredItem, "500 mg", 1);
    expect(markDoseSkipped(profileId, retired, retiredItem, DATE)).toBe(
      "stale-dose"
    );

    const pausedItem = seedItem(profileId, { active: 0, quantityOnHand: 5 });
    const pausedDose = seedDose(pausedItem, "500 mg");
    expect(markDoseSkipped(profileId, pausedDose, pausedItem, DATE)).toBe(
      "inactive"
    );
    expect(logRow(pausedDose, DATE)).toBeUndefined();
  });
});

// The write cores treat the callback token's supplement id and date as untrusted
// (issues #613/#614): the item is always derived from the DOSE row, and a date
// outside a small window around today is refused. A duplicate/raced write never
// throws (issue #616).
describe("dose write-path hardening (#613/#614/#616)", () => {
  it("ignores a forged cross-profile item id — writes the dose's OWN item, no foreign row", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    // A second profile whose item id the attacker splices into the token.
    const victim = seedProfileRow();
    const victimItem = seedItem(victim, { quantityOnHand: 10 });

    // Forged token: this profile's dose, but the victim's item id.
    expect(markDoseTaken(profileId, doseId, victimItem, DATE)).toBe(
      "stale-dose"
    );
    // Nothing written for the dose, and the victim profile's taken set is clean.
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(getIntakeLogsForDate(victim, DATE).has(victimItem)).toBe(false);
    // The victim's supply is untouched (no decrement against a foreign item).
    expect(onHand(victimItem)).toBe(10);
  });

  it("writes owned.item_id even when the token carries no supp id", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    expect(markDoseTaken(profileId, doseId, null, DATE)).toBe("logged");
    const row = db
      .prepare(
        "SELECT item_id FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, DATE) as { item_id: number };
    expect(row.item_id).toBe(itemId);
  });

  it("refuses a forged out-of-window date so a misdated row can't land", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "500 mg");

    const farFuture = shiftDateStr(DATE, 400);
    const farPast = shiftDateStr(DATE, -400);
    expect(markDoseTaken(profileId, doseId, itemId, farFuture)).toBe(
      "stale-dose"
    );
    expect(markDoseSkipped(profileId, doseId, itemId, farPast)).toBe(
      "stale-dose"
    );
    expect(logRow(doseId, farFuture)).toBeUndefined();
    expect(logRow(doseId, farPast)).toBeUndefined();
    // Supply never moved and today's slot is still open.
    expect(onHand(itemId)).toBe(10);
    // A same-day tap still works.
    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe("logged");
  });

  it("markDoseSkipped also ignores a forged item id", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "5 mg");
    const victim = seedProfileRow();
    const victimItem = seedItem(victim);

    expect(markDoseSkipped(profileId, doseId, victimItem, DATE)).toBe(
      "stale-dose"
    );
    expect(logRow(doseId, DATE)).toBeUndefined();
  });

  it("a pre-existing (dose,date) log makes a repeat report its standing status, never throwing (#616)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "5 mg");

    // Simulate a concurrent web/offline writer having already logged today.
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, status) VALUES (?,?,?,'taken')"
    ).run(doseId, itemId, DATE);

    // The Telegram path must NOT throw on the duplicate — it reports already-taken
    // and leaves supply alone.
    expect(() => markDoseTaken(profileId, doseId, itemId, DATE)).not.toThrow();
    expect(markDoseTaken(profileId, doseId, itemId, DATE)).toBe(
      "already-taken"
    );
    expect(onHand(itemId)).toBe(10);
    // Exactly one row survives.
    const n = db
      .prepare(
        "SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, DATE) as { n: number };
    expect(n.n).toBe(1);
  });
});

// escalationAckState (#233's 👍 I'm-on-it verification) is status-aware (#280):
// an episode resolved by EITHER log status ends the chase and is reported by the
// status that stands — a deliberately-skipped critical dose must not be answered
// as a fresh "we'll hold off" (nor as confirmed taken).
describe("escalationAckState status-awareness (#280)", () => {
  it("acknowledges an unresolved dose, refuses retired/paused ones", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "5 mg");
    expect(escalationAckState(profileId, doseId, DATE)).toBe("acknowledged");

    const retired = seedDose(itemId, "5 mg", 1);
    expect(escalationAckState(profileId, retired, DATE)).toBe("stale-dose");

    const pausedItem = seedItem(profileId, { active: 0 });
    const pausedDose = seedDose(pausedItem, "5 mg");
    expect(escalationAckState(profileId, pausedDose, DATE)).toBe("inactive");
  });

  it("reports a taken dose as already-taken and a skipped one as already-skipped", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);

    const takenDose = seedDose(itemId, "5 mg");
    markDoseTaken(profileId, takenDose, itemId, DATE);
    expect(escalationAckState(profileId, takenDose, DATE)).toBe(
      "already-taken"
    );

    const skippedDose = seedDose(itemId, "5 mg");
    markDoseSkipped(profileId, skippedDose, itemId, DATE);
    expect(escalationAckState(profileId, skippedDose, DATE)).toBe(
      "already-skipped"
    );
  });
});

describe("offline dose replay rides the shared write cores (#1427)", () => {
  it("stamps the CAPTURED tap time, snapshots the amount, and decrements supply once", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "2 caps");

    // Local midnight of the log's own day: unambiguously inside DATE in the profile
    // timezone and (except for the first instant of the day) hours before "now", so
    // the stored recorded_at could not have come from datetime('now').
    const tapped = zonedWallTimeToUtc(getTimezone(profileId), DATE, "00:00")!;

    expect(
      applyIntent(
        profileId,
        doseIntent("dose", doseId, { clientTakenAt: tapped.toISOString() })
      )
    ).toEqual({ status: "done" });
    expect(logRow(doseId, DATE)).toEqual({ amount: "2 caps", status: "taken" });
    expect(recordedAt(doseId, DATE)).toBe(utcSqlString(tapped));
    expect(onHand(itemId)).toBe(9);
  });

  it("ignores an unusable client timestamp instead of dropping the dose", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const doseId = seedDose(itemId, "1 cap");

    // A phone whose clock is a year fast: the confirm still lands (losing the minute
    // beats losing the medication log), stamped by the server instead.
    const skewed = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(
      applyIntent(
        profileId,
        doseIntent("dose", doseId, { clientTakenAt: skewed.toISOString() })
      )
    ).toEqual({ status: "done" });
    expect(logRow(doseId, DATE)?.status).toBe("taken");
    expect(recordedAt(doseId, DATE)).not.toBe(utcSqlString(skewed));
    expect(recordedAt(doseId, DATE)).toBeTruthy();
  });

  it("REFUSES a paused item with an honest reason (the parallel-path regression)", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { active: 0, quantityOnHand: 6 });
    const doseId = seedDose(itemId, "1 cap");

    const result = applyIntent(profileId, doseIntent("dose", doseId));
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/paused/i);
    // Nothing logged, no supply burned for an item the user deliberately paused.
    expect(logRow(doseId, DATE)).toBeUndefined();
    expect(onHand(itemId)).toBe(6);
  });

  it("refuses a retired dose and a dose owned by another profile", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId);
    const retired = seedDose(itemId, "1 cap", 1);
    const foreign = seedDose(seedItem(seedProfileRow()), "1 cap");

    for (const doseId of [retired, foreign]) {
      const result = applyIntent(profileId, doseIntent("dose", doseId));
      expect(result.status).toBe("rejected");
      expect(result.reason).toMatch(/no longer on the schedule/i);
      expect(logRow(doseId, DATE)).toBeUndefined();
    }
  });

  it("refuses an entry that sat in the queue past the dose-log window", () => {
    const profileId = seedProfileRow();
    const doseId = seedDose(seedItem(profileId), "1 cap");
    const longAgo = shiftDateStr(DATE, -30);

    const result = applyIntent(
      profileId,
      doseIntent("dose", doseId, {
        date: longAgo,
      })
    );
    expect(result).toEqual({
      status: "rejected",
      reason: STALE_QUEUED_DOSE_REASON,
    });
    expect(logRow(doseId, longAgo)).toBeUndefined();
  });

  it("is idempotent: the same key duplicates, a fresh key on a taken dose is done", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 10 });
    const doseId = seedDose(itemId, "1 cap");

    const intent = doseIntent("dose", doseId);
    expect(applyIntent(profileId, intent)).toEqual({ status: "done" });
    // Same idempotency key (a racing flush) — short-circuits before any write.
    expect(applyIntent(profileId, intent)).toEqual({ status: "duplicate" });
    // A DIFFERENT key for the same already-confirmed dose+day is already-done, not a
    // second log and not a rejection.
    expect(applyIntent(profileId, doseIntent("dose", doseId))).toEqual({
      status: "done",
    });
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ? AND date = ?"
          )
          .get(doseId, DATE) as { n: number }
      ).n
    ).toBe(1);
    expect(onHand(itemId)).toBe(9); // decremented exactly once
  });

  it("never overwrites the OTHER resolution — and says so", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 5 });
    const skippedDose = seedDose(itemId, "1 cap");
    markDoseSkipped(profileId, skippedDose, itemId, DATE);

    const confirm = applyIntent(profileId, doseIntent("dose", skippedDose));
    expect(confirm.status).toBe("rejected");
    expect(confirm.reason).toMatch(/already recorded as skipped/i);
    expect(logRow(skippedDose, DATE)?.status).toBe("skipped");
    expect(onHand(itemId)).toBe(5);

    const takenDose = seedDose(itemId, "1 cap");
    markDoseTaken(profileId, takenDose, itemId, DATE);
    const skip = applyIntent(profileId, doseIntent("skip-dose", takenDose));
    expect(skip.status).toBe("rejected");
    expect(skip.reason).toMatch(/already recorded as taken/i);
    expect(logRow(takenDose, DATE)?.status).toBe("taken");
  });

  it("applies a queued skip without touching supply", () => {
    const profileId = seedProfileRow();
    const itemId = seedItem(profileId, { quantityOnHand: 8 });
    const doseId = seedDose(itemId, "500 mg");

    expect(applyIntent(profileId, doseIntent("skip-dose", doseId))).toEqual({
      status: "done",
    });
    expect(logRow(doseId, DATE)).toEqual({ amount: null, status: "skipped" });
    expect(onHand(itemId)).toBe(8);
    // A second queued skip on the same day is already-done, never a duplicate row.
    expect(applyIntent(profileId, doseIntent("skip-dose", doseId))).toEqual({
      status: "done",
    });
  });
});
