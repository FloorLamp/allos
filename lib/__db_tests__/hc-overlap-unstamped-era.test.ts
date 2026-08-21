// DB INTEGRATION TIER — the THIRD STATE of `metric_samples.pushed_at` (#3424).
//
// WHAT IS BEING GUARDED, AND THE DEFECT IT CLOSES. The supersede rule read a NULL
// `pushed_at` as "older than every stamp". NULL means UNKNOWN — and on deploy day EVERY
// row in the store is NULL, the correct ones included, and it stays NULL for any day the
// exporter's rolling window no longer reaches until #3439 runs.
//
// Read as "old", the exact failure `pushed_at` was added to kill came back: a
// byte-identical replay of a pre-switch push (an ordinary travel case — the ingest route
// has no idempotency key, #3449, and a phone changing zone is offline in flight, so
// queued pushes drain late) deleted the CORRECT re-anchored row. Measured against
// #3424's own prod snapshot: pre-PR the day read 23330 for 11721 walked — wrong, but
// visibly wrong and repairable by #3439. At that head it read 11609 — LOW, which looks
// like a day you walked slightly less, and unrepairable, because the row holding the
// right number had been deleted.
//
// SO A NULL ROW IS DELETED ONLY ON PROOF OF BOTH HALVES, recorded once by the migration
// (lib/integrations/unstamped-era.ts):
//
//   * the row was already in the table when the column landed (id <= lastUnstampedId),
//   * and this push happened after that (stamp > startedAt).
//
// Every test here drives the REAL ingest and asserts a stored day total, because the two
// directions are what matter and they pull against each other: the rule must still
// collapse the four prod pairs #3424 measured (or it does not fix the bug), and it must
// not delete anything else that carries a NULL (or it makes the bug permanent).
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, no PHI.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  recordUnstampedEra,
  readUnstampedEra,
} from "@/lib/integrations/unstamped-era";
import {
  UNSTAMPED_ERA_AT_KEY,
  UNSTAMPED_ERA_MAX_ID_KEY,
} from "@/lib/metric-window-overlap";
import { getMetricDailyTotals } from "@/lib/queries";
import { setTimezone } from "@/lib/settings";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";
const ORIGIN_META = { metadata: { data_origin: ORIGIN } };

/** A profile whose rows no other test can explain. */
function freshProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

/**
 * A row written before the column existed: NULL stamp, exactly as every pre-PR row is.
 * Inserted through raw SQL because there is no longer a code path that writes one.
 */
function seedUnstamped(
  profileId: number,
  started_at: string,
  ended_at: string,
  value: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, started_at, ended_at, value)
         VALUES (?, ?, ?, 'steps', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        HC,
        ORIGIN,
        started_at.slice(0, 10),
        started_at,
        ended_at,
        value
      ).lastInsertRowid
  );
}

/**
 * Move the era markers so the rows seeded above count as PRE-existing.
 *
 * A test database is migrated with `metric_samples` empty, so the real marker is
 * `id = 0` and nothing a test seeds could ever be pre-era. Restating it here is what
 * makes the DEPLOY-DAY state reachable at all, and it is the only fixture in this file
 * that is not something the app itself wrote.
 */
function eraAfter(startedAt: string, lastUnstampedId: number): void {
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
    UNSTAMPED_ERA_AT_KEY,
    UNSTAMPED_ERA_MAX_ID_KEY
  );
  recordUnstampedEra(startedAt, lastUnstampedId);
}

function push(profileId: number, body: Record<string, unknown>) {
  const parsed = parseHealthConnectPayload(body, "UTC");
  return {
    split: ingestHealthConnectPayload(profileId, parsed).split,
    warnings: parsed.details.warnings,
  };
}

function stepsBody(
  timestamp: string | null,
  windows: [string, string, number][]
) {
  return {
    ...(timestamp ? { timestamp } : {}),
    app_version: "1.9.14",
    steps: windows.map(([start_time, end_time, count]) => ({
      start_time,
      end_time,
      count,
      ...ORIGIN_META,
    })),
  };
}

function dayTotal(profileId: number, date: string): number | undefined {
  return getMetricDailyTotals(profileId, "steps").find((t) => t.date === date)
    ?.value;
}

function storedValues(profileId: number): number[] {
  return (
    db
      .prepare(
        "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'steps' ORDER BY started_at"
      )
      .all(profileId) as { value: number }[]
  ).map((r) => r.value);
}

// #3424's prod snapshot, profile 1, 2026-08-20 steps: the New-York-anchored row and the
// Los-Angeles-anchored one that re-contains it, both NULL, the day reading 23330 for
// 11721 walked.
const NY: [string, string, number] = [
  "2026-08-20T04:00:00Z",
  "2026-08-20T20:00:00Z",
  11609,
];
const LA: [string, string, number] = [
  "2026-08-20T07:00:00Z",
  "2026-08-20T21:00:00Z",
  11721,
];

let era: { startedAt: string; lastUnstampedId: number } | null;
beforeEach(() => {
  era = readUnstampedEra();
});

describe("the era the migration recorded", () => {
  it("is written by the real migration, and both halves are readable", () => {
    // MUTATION: drop either `settings` write from the migration and `readUnstampedEra`
    // returns null, which makes the four prod pairs uncollapsible — the test below.
    expect(era).not.toBeNull();
    expect(era?.lastUnstampedId).toBeGreaterThanOrEqual(0);
    expect(era?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("never moves once written — a re-run is not a new era", () => {
    // A restore, a half-applied database, a second boot: all happen LATER than the
    // moment the column landed. Moving the marker forward would re-classify every row
    // written in between as pre-existing, which is the confusion it exists to end.
    const before = readUnstampedEra();
    recordUnstampedEra("2099-01-01T00:00:00Z", 999_999);
    expect(readUnstampedEra()).toEqual(before);
  });
});

describe("the direction the fix must NOT lose: the four prod pairs still collapse", () => {
  it("an honest post-deploy push replaces the pre-existing NULL row it overlaps", () => {
    const p = freshProfile("ERA-COLLAPSE");
    const nyId = seedUnstamped(p, ...NY);
    seedUnstamped(p, ...LA);
    expect(dayTotal(p, "2026-08-20")).toBe(23330);
    // Deploy: the column lands with those two rows already in the table.
    eraAfter("2026-08-21T00:00:00Z", nyId + 1);
    // The next real push, three minutes after the switch, carrying the LA anchoring.
    const r = push(
      p,
      stepsBody("2026-08-21T02:14:00Z", [
        ["2026-08-20T07:00:00Z", "2026-08-20T23:00:00Z", 11721],
      ])
    );
    expect(r.split.superseded).toBe(1);
    expect(storedValues(p)).toEqual([11721]);
    expect(dayTotal(p, "2026-08-20")).toBe(11721);
  });
});

describe("the direction four rounds kept losing: a NULL row is not losable", () => {
  it("a byte-identical replay of the PRE-SWITCH push deletes nothing", () => {
    const p = freshProfile("ERA-REPLAY");
    const nyId = seedUnstamped(p, ...NY);
    seedUnstamped(p, ...LA);
    eraAfter("2026-08-21T00:00:00Z", nyId + 1);
    // A push the phone made BEFORE the deploy, queued while it was offline in flight,
    // delivered now. Its stamp predates the era, so it knows nothing about these rows.
    // MUTATION: drop the `incoming > startedAt` half of `pushOutranks` and the 11721
    // row is deleted — the day reads 11609, LOW, and #3439 can no longer repair it.
    const r = push(p, stepsBody("2026-08-20T20:00:05Z", [NY]));
    expect(r.split.superseded).toBe(0);
    expect(storedValues(p)).toEqual([11609, 11721]);
    // Still wrong, still VISIBLY wrong, still exactly what #3439 repairs.
    expect(dayTotal(p, "2026-08-20")).toBe(23330);
    expect(r.warnings.join(" ")).toContain("1 daily total");
  });

  it("a stale push cannot take a NULL row the migration never saw", () => {
    const p = freshProfile("ERA-AFTER");
    // Deploy first, with an empty store.
    eraAfter("2026-08-21T00:00:00Z", 0);
    // A stampless push writes the CURRENT anchoring — NULL stamp, but written AFTER the
    // era, so nothing about it is "already-corrupted history".
    push(p, stepsBody(null, [LA]));
    // A stamped push carrying the OLD anchoring. Its stamp is after the era, so the
    // time half alone would let it through.
    // MUTATION: drop the `id <= lastUnstampedId` half and the 11721 row is deleted and
    // the day reads 11609 for 11721 walked. Verified red as zzr6-attack A2b.
    const r = push(p, stepsBody("2026-08-21T04:00:05Z", [NY]));
    expect(r.split.superseded).toBe(0);
    expect(storedValues(p)).toEqual([11609, 11721]);
  });

  it("supersedes nothing NULL at all when the era was never recorded", () => {
    const p = freshProfile("ERA-MISSING");
    const nyId = seedUnstamped(p, ...NY);
    seedUnstamped(p, ...LA);
    db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
      UNSTAMPED_ERA_AT_KEY,
      UNSTAMPED_ERA_MAX_ID_KEY
    );
    try {
      // A stamp in the PAST, deliberately: `pushStampFor` refuses one more than
      // MAX_PUSH_CLOCK_SKEW_MS ahead of this clock, and a refused stamp declines the
      // supersede for a different reason — which is how this case survived its first
      // mutant while asserting nothing about the era.
      const r = push(
        p,
        stepsBody("2026-08-21T04:00:05Z", [
          ["2026-08-20T07:00:00Z", "2026-08-20T23:00:00Z", 11721],
        ])
      );
      expect(r.split.superseded).toBe(0);
      expect(dayTotal(p, "2026-08-20")).toBe(23330);
    } finally {
      if (era) recordUnstampedEra(era.startedAt, era.lastUnstampedId);
      else recordUnstampedEra("2026-08-21T00:00:00Z", nyId);
    }
  });

  it("leaves a STAMPED row decided by its own stamp — the era widens nothing", () => {
    const p = freshProfile("ERA-STAMPED");
    // The whole store was written after the era, so every row carries a stamp.
    eraAfter("2026-08-21T00:00:00Z", 0);
    push(p, stepsBody("2026-08-21T21:00:05Z", [LA]));
    // An older push may not take it, era or no era.
    expect(
      push(p, stepsBody("2026-08-21T20:00:05Z", [NY])).split.superseded
    ).toBe(0);
    // A newer one may. It supersedes the NY row; the LA row is its own natural-key
    // twin, which the candidate SELECT excludes and the upsert overwrites in place.
    expect(
      push(
        p,
        stepsBody("2026-08-21T23:00:05Z", [
          ["2026-08-20T07:00:00Z", "2026-08-21T00:00:00Z", 11800],
        ])
      ).split.superseded
    ).toBe(1);
    expect(storedValues(p)).toEqual([11800]);
  });
});

describe("no row of one push is another row's victim, whatever the era", () => {
  // The argument that replaced phase 1, and the one the unconditional DELETE now rests
  // on. It has to hold in the presence of the era path too: a push that WRITES a row
  // must not then let a later row of the same push read it as unknown-and-pre-existing.
  it("a push carrying both anchorings stores both, era or no era", () => {
    const p = freshProfile("ERA-BOTH");
    eraAfter("2026-08-21T00:00:00Z", 0);
    const r = push(p, stepsBody("2026-08-21T21:00:05Z", [NY, LA]));
    expect(r.split.superseded).toBe(0);
    expect(storedValues(p)).toEqual([11609, 11721]);
    // And the next push with a later stamp collapses it (ruling item 3): the NY row is
    // superseded, the LA row is the incoming row's own twin and is overwritten.
    expect(
      push(
        p,
        stepsBody("2026-08-21T22:00:05Z", [
          ["2026-08-20T07:00:00Z", "2026-08-20T23:00:00Z", 11800],
        ])
      ).split.superseded
    ).toBe(1);
    expect(storedValues(p)).toEqual([11800]);
  });

  it("a STAMPLESS push carrying both anchorings stores both", () => {
    // Same shape with `pushedAt` null: `pushOutranks` refuses outright, so the era
    // cannot be reached at all and neither row can take the other.
    const p = freshProfile("ERA-BOTH-STAMPLESS");
    eraAfter("2026-08-21T00:00:00Z", 0);
    const r = push(p, stepsBody(null, [NY, LA]));
    expect(r.split.superseded).toBe(0);
    expect(storedValues(p)).toEqual([11609, 11721]);
  });
});
