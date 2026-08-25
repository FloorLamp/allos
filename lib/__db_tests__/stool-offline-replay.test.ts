// DB INTEGRATION TIER — Bristol stool-form offline replay (#3166 Q5 / #3275).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildIntent } from "@/lib/offline/queue";
import { applyIntent } from "@/lib/offline/writes";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function rows(profileId: number) {
  return db
    .prepare(
      `SELECT date, started_at, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = ?
        ORDER BY started_at`
    )
    .all(profileId, BRISTOL_STOOL_METRIC) as Array<{
    date: string;
    started_at: string;
    value: number;
  }>;
}

describe("applyIntent — stool (#3166 Q5)", () => {
  it("replays the type at the captured instant and deduplicates the same intent", () => {
    const profileId = newProfile("stool-offline-replay");
    const intent = buildIntent(
      "stool",
      "2026-08-22",
      { type: 4 },
      profileId,
      new Date("2026-08-22T08:12:34.000Z")
    );

    expect(applyIntent(profileId, intent)).toEqual({ status: "done" });
    expect(rows(profileId)).toEqual([
      {
        date: "2026-08-22",
        started_at: "2026-08-22T08:12:34",
        value: 4,
      },
    ]);

    expect(applyIntent(profileId, intent)).toEqual({ status: "duplicate" });
    expect(rows(profileId)).toHaveLength(1);
  });

  it("rejects an unknown Bristol type and records no replay key", () => {
    const profileId = newProfile("stool-offline-invalid");
    const intent = buildIntent(
      "stool",
      "2026-08-22",
      { type: 8 },
      profileId,
      new Date("2026-08-22T09:10:11.000Z")
    );

    expect(applyIntent(profileId, intent)).toEqual({ status: "rejected" });
    expect(rows(profileId)).toEqual([]);
    expect(applyIntent(profileId, { ...intent, payload: { type: 3 } })).toEqual(
      {
        status: "done",
      }
    );
  });
});
