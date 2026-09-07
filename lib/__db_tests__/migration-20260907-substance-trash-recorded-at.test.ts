import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runMigrations } from "@/lib/migrations/runner";
import { MIGRATIONS, migrationsBefore } from "@/lib/migrations/versions";
import { up } from "@/lib/migrations/versions/20260907-substance-trash-recorded-at";
import { restoreDeletedRow } from "@/lib/undo-delete-db";

const MIGRATION = "20260907-substance-trash-recorded-at";

function legacyEntry(profileId: number) {
  return {
    id: 7001,
    profile_id: profileId,
    date: "2026-08-14",
    substance: "nicotine",
    units: 2,
    logged_at: "2026-08-14T12:34:56.789Z",
    created_at: "2026-08-14 12:34:56",
    source: "manual",
    edited: 1,
    notes: "after lunch",
  };
}

function insertCapture(
  target: Database.Database,
  profileId: number,
  kind: string,
  payload: unknown
): number {
  return Number(
    target
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
         VALUES (?, ?, 'substance use history', ?)`
      )
      .run(profileId, kind, payload).lastInsertRowid
  );
}

function storedPayload(target: Database.Database, id: number): unknown {
  return (
    target.prepare(`SELECT payload FROM deleted_rows WHERE id = ?`).get(id) as {
      payload: unknown;
    }
  ).payload;
}

describe("#5406 substance-history trash payload compatibility", () => {
  it("rewrites the legacy key and restores through the real undo engine", () => {
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('Legacy trash restore')")
        .run().lastInsertRowid
    );
    db.prepare(
      `INSERT INTO substance_daily_totals
         (profile_id, date, substance, units, recorded_at, source, notes)
       VALUES (?, '2026-08-15', 'cannabis', 1,
               '2026-08-15T08:00:00Z', 'manual', 'standing row')`
    ).run(profileId);
    db.prepare(
      `INSERT INTO substance_log_events
         (profile_id, substance, date, recorded_at, occurred_at, time_source,
          logged_via, notes)
       VALUES (?, 'cannabis', '2026-08-15', '2026-08-15T08:00:00Z',
               '2026-08-15T07:55:00Z', 'stated', 'page', 'standing event')`
    ).run(profileId);
    const liveTotalsBefore = db
      .prepare(
        `SELECT * FROM substance_daily_totals WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId);
    const liveEventsBefore = db
      .prepare(
        `SELECT * FROM substance_log_events WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId);

    const undoId = insertCapture(
      db,
      profileId,
      "substance-history",
      JSON.stringify({
        v: 1,
        kind: "substance-history",
        rows: { entry: [legacyEntry(profileId)], events: [] },
      })
    );

    up(db);

    expect(
      db
        .prepare(
          `SELECT * FROM substance_daily_totals WHERE profile_id = ? ORDER BY id`
        )
        .all(profileId)
    ).toEqual(liveTotalsBefore);
    expect(
      db
        .prepare(
          `SELECT * FROM substance_log_events WHERE profile_id = ? ORDER BY id`
        )
        .all(profileId)
    ).toEqual(liveEventsBefore);
    const repaired = JSON.parse(String(storedPayload(db, undoId))) as {
      rows: { entry: Record<string, unknown>[]; events: unknown[] };
    };
    expect(repaired.rows.entry[0]).not.toHaveProperty("logged_at");
    expect(repaired.rows.entry[0].recorded_at).toBe("2026-08-14T12:34:56.789Z");
    expect(repaired.rows.events).toEqual([]);

    expect(restoreDeletedRow(profileId, undoId)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT date, substance, units, recorded_at, created_at, source,
                  edited, notes, logged_via
             FROM substance_daily_totals
            WHERE profile_id = ? AND substance = 'nicotine'`
        )
        .get(profileId)
    ).toEqual({
      date: "2026-08-14",
      substance: "nicotine",
      units: 2,
      recorded_at: "2026-08-14T12:34:56.789Z",
      created_at: "2026-08-14 12:34:56",
      source: "manual",
      edited: 1,
      notes: "after lunch",
      logged_via: null,
    });
  });

  it("is scoped, idempotent, and preserves canonical and malformed payloads", () => {
    const target = new Database(":memory:");
    runMigrations(target, migrationsBefore(MIGRATION));
    target
      .prepare("INSERT INTO profiles (id, name) VALUES (1, 'Payload cases')")
      .run();

    const legacy = insertCapture(
      target,
      1,
      "substance-history",
      JSON.stringify({
        v: 1,
        kind: "substance-history",
        rows: {
          entry: [legacyEntry(1)],
          events: [{ marker: "leave this child alone" }],
        },
        marker: "leave this payload field alone",
      })
    );
    const dualEntry = {
      ...legacyEntry(1),
      recorded_at: "2026-08-14T09:00:00Z",
    };
    const dual = insertCapture(
      target,
      1,
      "substance-history",
      JSON.stringify({
        v: 1,
        kind: "substance-history",
        rows: { entry: [dualEntry], events: [] },
      })
    );
    const canonicalText = JSON.stringify(
      {
        v: 1,
        kind: "substance-history",
        rows: {
          entry: [
            {
              ...legacyEntry(1),
              logged_at: undefined,
              recorded_at: "2026-08-14T10:00:00Z",
            },
          ],
          events: [],
        },
      },
      null,
      2
    );
    const canonical = insertCapture(
      target,
      1,
      "substance-history",
      canonicalText
    );
    const unrelatedText = JSON.stringify({
      v: 1,
      kind: "cycle",
      rows: { entry: [{ logged_at: "unrelated" }] },
    });
    const unrelated = insertCapture(target, 1, "cycle", unrelatedText);
    const unparseableText = "{not-json";
    const unparseable = insertCapture(
      target,
      1,
      "substance-history",
      unparseableText
    );
    const malformedText = JSON.stringify({
      v: 1,
      kind: "substance-history",
      rows: { entry: [null, { logged_at: "do not partially rewrite" }] },
    });
    const malformed = insertCapture(
      target,
      1,
      "substance-history",
      malformedText
    );

    runMigrations(target, MIGRATIONS);

    const repaired = JSON.parse(String(storedPayload(target, legacy))) as {
      rows: {
        entry: Record<string, unknown>[];
        events: Record<string, unknown>[];
      };
      marker: string;
    };
    expect(repaired.rows.entry[0]).not.toHaveProperty("logged_at");
    expect(repaired.rows.entry[0].recorded_at).toBe("2026-08-14T12:34:56.789Z");
    expect(repaired.rows.events).toEqual([
      { marker: "leave this child alone" },
    ]);
    expect(repaired.marker).toBe("leave this payload field alone");

    const repairedDual = JSON.parse(String(storedPayload(target, dual))) as {
      rows: { entry: Record<string, unknown>[] };
    };
    expect(repairedDual.rows.entry[0]).not.toHaveProperty("logged_at");
    expect(repairedDual.rows.entry[0].recorded_at).toBe("2026-08-14T09:00:00Z");
    expect(storedPayload(target, canonical)).toBe(canonicalText);
    expect(storedPayload(target, unrelated)).toBe(unrelatedText);
    expect(storedPayload(target, unparseable)).toBe(unparseableText);
    expect(storedPayload(target, malformed)).toBe(malformedText);

    const once = target
      .prepare(`SELECT id, payload FROM deleted_rows ORDER BY id`)
      .all();
    up(target);
    expect(
      target.prepare(`SELECT id, payload FROM deleted_rows ORDER BY id`).all()
    ).toEqual(once);
    target.close();
  });

  it("is safe when deleted_rows is absent", () => {
    const target = new Database(":memory:");
    expect(() => up(target)).not.toThrow();
    target.close();
  });
});
