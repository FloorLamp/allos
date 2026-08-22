// DB INTEGRATION TIER — `logged_via`, the durable record of WHICH SURFACE a person
// logged from (#3087).
//
// This file holds the schema half (the migration's columns, their nullability, and
// the absence of any foreign key), the two CHAT surfaces driven through their real
// callback handlers, and the two rules that decide what the column means over time:
// an edit never rewrites it, and `source` keeps its own meaning beside it.
//
// The four WEB surfaces and the offline replay are in
// lib/__action_tests__/logged-via-surfaces.actions.test.ts, where the Server Actions
// and the replay route they post to can be driven with a real login→profile pairing.

import { beforeAll, describe, expect, it } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { LEDGERS_WITH_LOGGED_VIA, isLoggedVia } from "@/lib/logged-via";
import { updatePracticeSession } from "@/lib/practice-log";
import { practiceIdentity } from "@/lib/practice";
import {
  logFoodServingCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { recordReading } from "@/lib/reading-writes";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { seedProfile, seedLoginTelegram, type SeededProfile } from "./fixtures";

beforeAll(() => stubTelegramSends());

const CHAT = "5550361";

function cq(data: string) {
  return {
    id: "cbq-lv",
    data,
    message: {
      message_id: 41,
      chat: { id: CHAT },
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
    },
  };
}

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("LV3087");
  seedLoginTelegram(p.profileId, CHAT);
});

/** A practice frequency target — the thing a `pdone:` / `plog:` button names. */
function practiceTarget(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week)
         VALUES (?, 'practice', ?, ?, 3)`
      )
      .run(p.profileId, name, practiceIdentity(name)).lastInsertRowid
  );
}

function practiceRow(name: string) {
  return db
    .prepare(
      `SELECT logged_via, edited FROM practice_logs
        WHERE profile_id = ? AND practice = ? ORDER BY id DESC LIMIT 1`
    )
    .get(p.profileId, name) as
    { logged_via: string | null; edited: number | null } | undefined;
}

/** A fresh scheduled dose with nothing logged against it yet. */
function freshDose(name: string): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
         VALUES (?, ?, 'supplement', 1, 'should')`
      )
      .run(p.profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, sort) VALUES (?, '1', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function doseOrigin(doseId: number, date: string): string | null | undefined {
  return (
    db
      .prepare(
        `SELECT logged_via FROM intake_item_logs
          WHERE dose_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
      )
      .get(doseId, date) as { logged_via: string | null } | undefined
  )?.logged_via;
}

describe("the migration's shape", () => {
  it("gives every tranche ledger a nullable logged_via with no default", () => {
    for (const table of LEDGERS_WITH_LOGGED_VIA) {
      const col = (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }[]
      ).find((c) => c.name === "logged_via");
      expect(col, `${table} has no logged_via column`).toBeDefined();
      expect(col?.type, table).toBe("TEXT");
      // Nullable: every pre-migration row reads NULL, which means "unknown".
      expect(col?.notnull, table).toBe(0);
      // NO DEFAULT. A default would put a guess in the one column whose value is that
      // it never guesses — a write path that forgot to stamp would then look like a
      // surface instead of looking like the bug it is.
      expect(col?.dflt_value, table).toBeNull();
    }
  });

  it("carries the column on EXACTLY the tranche — asked of the SCHEMA, not the list", () => {
    // THE REVERSE DIRECTION, and the one that catches a demotion. Every assertion
    // above loops `for (const table of LEDGERS_WITH_LOGGED_VIA)`, which is satisfied
    // by DELETING a name: remove `symptom_logs` from the list, add it to the census's
    // NOT_A_USER_WRITE_LEDGER with a reason, and a shipped ledger whose column exists
    // and whose write cores stamp it is reclassified as "not a place a person logs
    // something about themselves" with every guard in both tiers still green. That
    // mutant was run and it survived; this is what kills it.
    //
    // The question is asked of `sqlite_master` — every table the migrated database
    // actually has — so the answer cannot be derived from the list it is checking.
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const carrying = tables
      .filter((table) =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === "logged_via")
      )
      .sort();
    expect(carrying.length).toBeGreaterThan(0);
    expect(
      carrying,
      "The tables that actually carry `logged_via` and LEDGERS_WITH_LOGGED_VIA " +
        "disagree (#3087). A ledger cannot leave the tranche by being deleted from " +
        "a list — the column is still on the table and its cores still stamp it."
    ).toEqual([...LEDGERS_WITH_LOGGED_VIA].sort());
  });

  it("takes NO foreign key — the whole lesson of notify_message_id", () => {
    // `notify_message_id` is `REFERENCES notify_messages(id) ON DELETE SET NULL`
    // against a table pruned on a 3-day retention, so it is DESIGNED to evaporate,
    // and it therefore answers nothing about last month. A provenance column that
    // did the same would reproduce the exact defect #3087 exists to correct, so the
    // negative is asserted directly, per ledger.
    for (const table of LEDGERS_WITH_LOGGED_VIA) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
        from: string;
        table: string;
      }[];
      expect(
        fks.filter((f) => f.from === "logged_via"),
        `${table}.logged_via must not reference anything`
      ).toEqual([]);
    }
  });

  it("leaves a pre-migration row reading NULL, with no inference run", () => {
    // The migration only ADDs columns, so a row written without one — which is what
    // every historical row is — reads NULL. Inferring a surface from the handful of
    // rows that still carry a `notify_message_id` would seed the model with the
    // survivors of a 3-day prune, which is pure survivorship bias.
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_logs (profile_id, practice, date)
           VALUES (?, 'lv legacy row', ?)`
        )
        .run(p.profileId, today(p.profileId)).lastInsertRowid
    );
    const row = db
      .prepare("SELECT logged_via FROM practice_logs WHERE id = ?")
      .get(id) as { logged_via: string | null };
    expect(row.logged_via).toBeNull();
  });
});

describe("the chat surfaces, driven through their real handlers", () => {
  it("a TELEGRAM NUDGE tap stores telegram-nudge", async () => {
    // A dose reminder's ✅ button: `take:<profile>:<dose>:<item>:<date>` — the token
    // the proactive send builds, taken through the real callback dispatcher.
    const date = today(p.profileId);
    const { itemId, doseId } = freshDose("lv nudge supplement");
    await handleCallbackQuery(
      cq(`take:${p.profileId}:${doseId}:${itemId}:${date}`)
    );
    expect(doseOrigin(doseId, date)).toBe("telegram-nudge");
  });

  it("tells the two CHAT surfaces apart on ONE handler (pdone nudge vs plog command)", async () => {
    // `pdone:` is the pace NUDGE; `plog:` is the on-demand `/practice` list. Both taps
    // run through the SAME handler and the SAME write core — what differs is what the
    // message claims — so this is exactly the case a coarser vocabulary (#2168's
    // three-value `web | telegram | offline-replay`) could not answer at all. It is
    // also the case the 34-day adherence clustering needs: taps at the reminder hours
    // are only evidence about the nudge if a tap can say it came from one.
    const nudged = practiceTarget("lv nudge practice");
    const listed = practiceTarget("lv list practice");

    await handleCallbackQuery(cq(`pdone:${p.profileId}:${nudged}:n1`));
    expect(practiceRow("lv nudge practice")?.logged_via).toBe("telegram-nudge");

    await handleCallbackQuery(cq(`plog:${p.profileId}:${listed}:n2`));
    expect(practiceRow("lv list practice")?.logged_via).toBe(
      "telegram-command"
    );
  });

  it("a SLASH-COMMAND PRN tap stores telegram-command", async () => {
    // The `/dose` list's one-tap button, routed through the same dispatcher.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation)
           VALUES (?, 'lv prn med', 'medication', 1, 'may')`
        )
        .run(p.profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, sort) VALUES (?, '1 tab', 0)`
    ).run(itemId);

    await handleCallbackQuery(cq(`prn:${p.profileId}:${itemId}:lv1`));
    const row = db
      .prepare(
        `SELECT logged_via FROM intake_item_logs
          WHERE item_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(itemId) as { logged_via: string | null } | undefined;
    expect(row?.logged_via).toBe("telegram-command");
  });
});

describe("creation, not mutation", () => {
  it("leaves logged_via alone when a symptom day is RE-TAPPED from another surface", () => {
    const date = today(p.profileId);
    expect(
      logSymptomCore(p.profileId, "lv headache", 2, date, "quick-log").kind
    ).toBe("logged");
    const before = db
      .prepare(
        `SELECT logged_via FROM symptom_logs
          WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .get(p.profileId, date, "lv headache") as { logged_via: string | null };
    expect(before.logged_via).toBe("quick-log");

    // The upsert raises the day's severity and must NOT rewrite where the row came
    // from: an edit is not a new tap.
    logSymptomCore(p.profileId, "lv headache", 4, date, "telegram-command");
    const after = db
      .prepare(
        `SELECT logged_via, severity FROM symptom_logs
          WHERE profile_id = ? AND date = ? AND symptom = ?`
      )
      .get(p.profileId, date, "lv headache") as {
      logged_via: string | null;
      severity: number;
    };
    expect(after.severity).toBe(4);
    expect(after.logged_via).toBe("quick-log");
  });

  it("leaves a food event's origin alone when its meal is CORRECTED", () => {
    const date = today(p.profileId);
    expect(
      logFoodServingCore(p.profileId, "fatty_fish", date, "dashboard-widget")
        .kind
    ).toBe("logged");
    const row = db
      .prepare(
        `SELECT id, logged_via FROM food_log_events
          WHERE profile_id = ? AND date = ? ORDER BY id DESC LIMIT 1`
      )
      .get(p.profileId, date) as { id: number; logged_via: string | null };
    expect(row.logged_via).toBe("dashboard-widget");

    updateFoodLogEventCore(p.profileId, row.id, { mealSlot: "Evening" });
    const after = db
      .prepare("SELECT logged_via FROM food_log_events WHERE id = ?")
      .get(row.id) as { logged_via: string | null };
    // A correction moves the meal, never the provenance.
    expect(after.logged_via).toBe("dashboard-widget");
  });

  it("leaves a practice session's origin alone when the session is EDITED", () => {
    const date = today(p.profileId);
    const id = Number(
      db
        .prepare(
          `INSERT INTO practice_logs (profile_id, practice, date, logged_via)
           VALUES (?, 'lv edit target', ?, 'page')`
        )
        .run(p.profileId, date).lastInsertRowid
    );
    updatePracticeSession(p.profileId, id, { date, durationMin: 30 });
    const row = db
      .prepare("SELECT logged_via, edited FROM practice_logs WHERE id = ?")
      .get(id) as { logged_via: string | null; edited: number | null };
    expect(row.logged_via).toBe("page");
    // `edited` is where "this was touched later" already lives — the separate fact
    // the creation-not-mutation rule leans on.
    expect(row.edited).toBe(1);
  });

  it("stores only vocabulary members, never a free string", () => {
    const stored = db
      .prepare(
        `SELECT DISTINCT logged_via FROM practice_logs WHERE logged_via IS NOT NULL
         UNION SELECT DISTINCT logged_via FROM intake_item_logs WHERE logged_via IS NOT NULL
         UNION SELECT DISTINCT logged_via FROM food_log_events WHERE logged_via IS NOT NULL
         UNION SELECT DISTINCT logged_via FROM symptom_logs WHERE logged_via IS NOT NULL`
      )
      .all() as { logged_via: string }[];
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(isLoggedVia(row.logged_via)).toBe(true);
  });
});

describe("orthogonal to source", () => {
  it("keeps both columns, meaning different things, on one row", () => {
    // `source` answers "which importer or integration produced this row";
    // `logged_via` answers "which surface a person used". Nothing is migrated from
    // one onto the other, and a hand-entered reading carries both: source 'manual'
    // (no importer) beside the surface that took it.
    const date = today(p.profileId);
    const outcome = recordReading(p.profileId, {
      name: "Resting Heart Rate",
      value: 51,
      unit: "bpm",
      date,
      source: "manual",
      loggedVia: "dashboard-widget",
    });
    expect(outcome.ok).toBe(true);
    const row = db
      .prepare(
        `SELECT source, logged_via FROM body_metrics
          WHERE profile_id = ? AND date = ? AND resting_hr IS NOT NULL
          ORDER BY id DESC LIMIT 1`
      )
      .get(p.profileId, date) as {
      source: string | null;
      logged_via: string | null;
    };
    expect(row.source).toBe("manual");
    expect(row.logged_via).toBe("dashboard-widget");
  });
});
