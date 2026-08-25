// DB INTEGRATION TIER — Bristol stool-form offline replay (#3166 Q5 / #3275).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildIntent } from "@/lib/offline/queue";
import { applyIntent, applyStoolEvent } from "@/lib/offline/writes";
import { BRISTOL_STOOL_METRIC } from "@/lib/bristol-stool";
import { setTimezone } from "@/lib/settings";

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
        ORDER BY started_at, id`
    )
    .all(profileId, BRISTOL_STOOL_METRIC) as Array<{
    date: string;
    started_at: string;
    value: number;
  }>;
}

describe("applyIntent — stool (#3166 Q5)", () => {
  it("uses one identity for the online action and response-loss replay", () => {
    const profileId = newProfile("stool-offline-replay");
    const intent = buildIntent(
      "stool",
      "2026-08-22",
      { type: 4 },
      profileId,
      new Date("2026-08-22T08:12:34.000Z")
    );

    expect(
      applyStoolEvent(profileId, {
        key: intent.key,
        capturedAt: intent.capturedAt,
        type: 4,
      })
    ).toEqual({ status: "done", date: "2026-08-22" });
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

  it("keeps distinct event keys that share one second and have different types", () => {
    const profileId = newProfile("stool-same-second");
    const captured = new Date("2026-08-22T08:12:34.000Z");
    const first = buildIntent(
      "stool",
      "2026-08-22",
      { type: 2 },
      profileId,
      captured,
      "10000000-0000-4000-8000-000000000001"
    );
    const second = buildIntent(
      "stool",
      "2026-08-22",
      { type: 6 },
      profileId,
      captured,
      "10000000-0000-4000-8000-000000000002"
    );

    expect(applyIntent(profileId, first)).toEqual({ status: "done" });
    expect(applyIntent(profileId, second)).toEqual({ status: "done" });
    expect(rows(profileId)).toEqual([
      {
        date: "2026-08-22",
        started_at: "2026-08-22T08:12:34",
        value: 2,
      },
      {
        date: "2026-08-22",
        started_at: "2026-08-22T08:12:34",
        value: 6,
      },
    ]);
  });

  it("derives both sides of local midnight from one normalized instant", () => {
    const profileId = newProfile("stool-midnight");
    setTimezone(profileId, "America/Los_Angeles");
    const before = buildIntent(
      "stool",
      // Hostile transport date: the writer must ignore it and project capturedAt.
      "2026-08-22",
      { type: 3 },
      profileId,
      new Date("2026-08-22T06:59:59.000Z")
    );
    const after = buildIntent(
      "stool",
      "2026-08-21",
      { type: 5 },
      profileId,
      new Date("2026-08-22T07:00:00.000Z")
    );

    expect(applyIntent(profileId, before)).toEqual({ status: "done" });
    expect(applyIntent(profileId, after)).toEqual({ status: "done" });
    expect(rows(profileId)).toEqual([
      {
        date: "2026-08-21",
        started_at: "2026-08-21T23:59:59",
        value: 3,
      },
      {
        date: "2026-08-22",
        started_at: "2026-08-22T00:00:00",
        value: 5,
      },
    ]);
  });

  it("normalizes a future device capture before deriving its local day and time", () => {
    const profileId = newProfile("stool-future-clock");
    setTimezone(profileId, "Pacific/Kiritimati");
    expect(
      applyStoolEvent(
        profileId,
        {
          key: "20000000-0000-4000-8000-000000000001",
          capturedAt: "2026-08-23T18:00:00.000Z",
          type: 7,
        },
        new Date("2026-08-22T10:05:06.000Z")
      )
    ).toEqual({ status: "done", date: "2026-08-23" });
    expect(rows(profileId)).toEqual([
      {
        date: "2026-08-23",
        started_at: "2026-08-23T00:05:06",
        value: 7,
      },
    ]);
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
