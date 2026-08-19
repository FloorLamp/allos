// DB INTEGRATION TIER — the durable post-workout dispatch claim (#3058).
//
// #3048 serialized the queued dispatches per profile, and its adversarial pass
// named the two callers the chain can never reach: another PROCESS (a
// web-process action timer racing the notify tick), and the shared core called
// DIRECTLY while a queued run is mid-send. Both pass the one-shot marker's
// read-then-act check before either stamps, and one activity produced two
// contacts. The owner ruling makes "one post-workout contact per session" a
// database-enforced property: a unique-key claim elects exactly one dispatcher,
// losers get typed outcomes, a total failure releases, and a crashed winner's
// claim expires on a lease.
//
// WHAT THIS FILE DOES NOT PROVE, on purpose: exactly-once across the external
// provider boundary. A winner crashing between the provider accepting and the
// local `sent` commit re-dispatches after the lease — the documented
// at-least-once edge (lib/notifications/post-workout-claim.ts header). Every
// case here asserts one ATTEMPTED dispatch per election, which is the property
// the ruling names.
//
// Every value is synthetic — a fake Home Assistant webhook, a fake supplement.
// No PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today, reopenDatabaseForTests } from "@/lib/db";
import {
  setProfileHomeAssistant,
  getProfileSetting,
  setSetting,
} from "@/lib/settings";
import { seedLoginTelegram } from "./fixtures";
import {
  runPostWorkoutForActivity,
  postWorkoutFinishMarkerKey,
} from "@/lib/notifications/workout-presence";
import {
  POST_WORKOUT_CLAIM_LEASE_MS,
  postWorkoutClaimState,
} from "@/lib/notifications/post-workout-claim";
import {
  flushPostWorkoutDispatches,
  queuePostWorkoutDispatch,
  POST_WORKOUT_DISPATCH_DELAY_MS,
  POST_WORKOUT_DISPATCH_TIMEOUT_MS,
} from "@/lib/notifications/post-workout-queue";
import { NOTIFICATION_DISPATCH_TIMEOUT_MS } from "@/lib/notifications/dispatch-deadline";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-claims";
const NOW = new Date("2026-07-17T18:00:00Z");

function newProfile(name: string, opts: { channel?: boolean } = {}): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (opts.channel !== false) {
    setProfileHomeAssistant(id, {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: [],
    });
  }
  // One post_workout dose, so the dispatch always has something to say and a
  // silent run can never be mistaken for a declined one.
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Electrolytes (test)', 1, 'supplement', 'post_workout', 'should')`
      )
      .run(id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 sachet', 'anytime', 'any', 0)`
  ).run(itemId);
  return id;
}

function seedSession(profileId: number, tag: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min, source, external_id)
         VALUES (?, ?, 'cardio', 'Biking', '09:04', '10:01', 57, 'health-connect', ?)`
      )
      .run(profileId, today(profileId), `health-connect:claims-${tag}`)
      .lastInsertRowid
  );
}

function marker(profileId: number, activityId: number): string | null {
  return (
    getProfileSetting(profileId, postWorkoutFinishMarkerKey(activityId)) ?? null
  );
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

// A fetch that hangs each call until the test releases it — the deferred
// delivery the concurrency criteria need, not a timing hope (the #3021 fixture
// discipline: a stub that resolves immediately serializes by accident).
function heldFetch(): {
  mock: ReturnType<typeof vi.fn>;
  releases: (() => void)[];
} {
  const releases: (() => void)[] = [];
  const mock = vi.fn(async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return { mock, releases };
}

// Let the microtask queue drain so an in-flight dispatch reaches (or leaves)
// its held network call under fake timers.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db.prepare("DELETE FROM notify_lifecycle").run();
});
afterEach(async () => {
  await flushPostWorkoutDispatches();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The election across genuinely separate database connections ─────────────

describe("two concurrent callers, separate connections, one activity (#3058)", () => {
  it("elects one dispatcher; the loser's outcome is typed and it contacts nobody", async () => {
    const { mock, releases } = heldFetch();
    const p = newProfile("PWC-two-conns");
    const a = seedSession(p, "two-conns");

    // Caller 1 claims on the first connection and is mid-send.
    const first = runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    await settle();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(postWorkoutClaimState(p, a)).toBe("pending");
    expect(marker(p, a)).toBeNull();

    // Caller 2 arrives on a NEW connection to the same database file — the
    // other-process shape the in-process promise chain can never serialize.
    reopenDatabaseForTests();
    const second = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(second).toEqual({ failed: false, outcome: "already-claimed" });
    expect(mock).toHaveBeenCalledTimes(1);

    // The winner finishes: one contact, a final claim, one marker.
    releases[0]();
    const r1 = await first;
    expect(r1).toEqual({ failed: false, outcome: "sent" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(postWorkoutClaimState(p, a)).toBe("sent");
    expect(marker(p, a)).not.toBeNull();
  });

  it("a sent claim is final across a fresh connection, independent of the marker", async () => {
    stubFetch();
    const p = newProfile("PWC-sent-final");
    const a = seedSession(p, "sent-final");
    const r = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(r.outcome).toBe("sent");

    // Remove the marker so ONLY the claim can be what refuses — the property is
    // database-enforced, not an emergent effect of the settings row.
    db.prepare(
      `DELETE FROM profile_settings WHERE profile_id = ? AND key = ?`
    ).run(p, postWorkoutFinishMarkerKey(a));
    // And cross a process boundary: a fresh connection is a restarted process's
    // view of the same file.
    reopenDatabaseForTests();

    const fetchMock = stubFetch();
    const again = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(again).toEqual({ failed: false, outcome: "already-sent" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postWorkoutClaimState(p, a)).toBe("sent");
  });
});

// ── The queued path racing the direct core path, one process ─────────────────

describe("the queued path racing the tick/core path (#3058)", () => {
  it("produces one dispatch attempt for one activity", async () => {
    const { mock, releases } = heldFetch();
    const p = newProfile("PWC-queue-race");
    const a = seedSession(p, "queue-race");

    // The web-process timer path arms and fires; its run is mid-send.
    queuePostWorkoutDispatch(p, a);
    await vi.advanceTimersByTimeAsync(POST_WORKOUT_DISPATCH_DELAY_MS);
    await settle();
    expect(mock).toHaveBeenCalledTimes(1);

    // The tick's flagship path calls the core DIRECTLY — no queue, no chain.
    // Before #3058 both passed the marker read and one ride sent twice; the
    // claim now answers the second caller before it builds a contact.
    const direct = await runPostWorkoutForActivity(p, a);
    expect(direct).toEqual({ failed: false, outcome: "already-claimed" });
    expect(mock).toHaveBeenCalledTimes(1);

    releases.forEach((release) => release());
    await settle();
    await flushPostWorkoutDispatches();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(marker(p, a)).not.toBeNull();
    expect(postWorkoutClaimState(p, a)).toBe("sent");
  });
});

// ── Delivery outcomes: finalize, release, retry ──────────────────────────────

describe("channel outcomes move the claim (#3058)", () => {
  it("a PARTIAL channel success finalizes `sent` — any delivered channel is a contact", async () => {
    // Two real channels through the real fan-out: Home Assistant delivers,
    // Telegram's transport fails. The contract's point 4: ANY successful
    // channel moves the claim to `sent` and stamps the marker in one
    // transaction — a partial failure is a delivery, never a retry.
    const routed = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("homeassistant"))
        return new Response(null, { status: 200 });
      return new Response(null, { status: 502 });
    });
    vi.stubGlobal("fetch", routed);
    const p = newProfile("PWC-partial");
    setSetting("telegram_bot_token", "test-bot-token");
    seedLoginTelegram(p, "5550311");
    const a = seedSession(p, "partial");

    const r = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(r).toEqual({ failed: true, outcome: "sent" });
    expect(postWorkoutClaimState(p, a)).toBe("sent");
    expect(marker(p, a)).not.toBeNull();
  });

  it("a TOTAL failure releases the claim and the retry band tries again", async () => {
    const failing = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", failing);
    const p = newProfile("PWC-total-failure");
    const a = seedSession(p, "total-failure");

    const r = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(r).toEqual({ failed: true, outcome: "failed" });
    // Released, not leased: the retry band (the hourly tick backstop) must not
    // wait out a lease for a failure that already resolved.
    expect(postWorkoutClaimState(p, a)).toBeNull();
    expect(marker(p, a)).toBeNull();

    // The next backstop run re-elects and delivers.
    const fetchMock = stubFetch();
    const retry = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(retry).toEqual({ failed: false, outcome: "sent" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(marker(p, a)).not.toBeNull();
  });

  it("no channel configured releases the claim (fire later, as before)", async () => {
    const fetchMock = stubFetch();
    const p = newProfile("PWC-no-channel", { channel: false });
    const a = seedSession(p, "no-channel");
    const r = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(r).toEqual({ failed: false, outcome: "no-channel" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(postWorkoutClaimState(p, a)).toBeNull();
    expect(marker(p, a)).toBeNull();
  });
});

// ── The lease: crashed winners become retryable, live ones do not ────────────

describe("the pending-claim lease (#3058)", () => {
  it("a LIVE lease refuses a second caller; a STALE one is taken over", async () => {
    // A "crashed" winner: its claim exists, its process never finalized or
    // released. Reached through the real election — a held dispatch abandoned
    // without release is exactly what a crash leaves behind.
    const { mock } = heldFetch();
    const p = newProfile("PWC-lease");
    const a = seedSession(p, "lease");
    void runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    await settle();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(postWorkoutClaimState(p, a)).toBe("pending");

    // Inside the lease: still claimed. (Deliberately just under the bound.)
    vi.setSystemTime(
      new Date(NOW.getTime() + POST_WORKOUT_CLAIM_LEASE_MS - 1000)
    );
    const fetchMock2 = stubFetch();
    const live = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(live).toEqual({ failed: false, outcome: "already-claimed" });
    expect(fetchMock2).not.toHaveBeenCalled();

    // Past the lease: the claim is a crash artifact and the next caller wins it.
    vi.setSystemTime(
      new Date(NOW.getTime() + POST_WORKOUT_CLAIM_LEASE_MS + 1000)
    );
    const fetchMock3 = stubFetch();
    const stale = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(stale).toEqual({ failed: false, outcome: "sent" });
    expect(fetchMock3).toHaveBeenCalledTimes(1);
    expect(postWorkoutClaimState(p, a)).toBe("sent");
    expect(marker(p, a)).not.toBeNull();
  });

  it("the lease exceeds the #3057 dispatch deadline AND the queue's whole-task guard", () => {
    // The ordering that makes a lease steal safe: a lawful winner still inside a
    // bounded dispatch (<= NOTIFICATION_DISPATCH_TIMEOUT_MS), or inside a queued
    // run's whole-task guard on top of it, can never be leased away mid-send.
    // Only a run past every deadline it could legally be inside loses its claim.
    expect(POST_WORKOUT_CLAIM_LEASE_MS).toBeGreaterThan(
      NOTIFICATION_DISPATCH_TIMEOUT_MS
    );
    expect(POST_WORKOUT_CLAIM_LEASE_MS).toBeGreaterThan(
      POST_WORKOUT_DISPATCH_TIMEOUT_MS
    );
  });
});

// ── The claim never replaces the #2570 layers ───────────────────────────────

describe("claiming keeps the #2570 checks in charge of twins", () => {
  it("declines a twin by the duplicate-cluster check, before any claim exists", async () => {
    const fetchMock = stubFetch();
    const p = newProfile("PWC-twin");
    const a = seedSession(p, "twin-a");
    // A second row of the SAME session — overlapping same-source times, the
    // #2570 high-confidence pair auto-merge declines.
    const b = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, start_time, end_time, duration_min, source, external_id)
           VALUES (?, ?, 'unclassified', 'Workout', '09:03', '10:01', 57, 'health-connect', 'health-connect:claims-twin-b')`
        )
        .run(p, today(p)).lastInsertRowid
    );

    const r1 = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(r1.outcome).toBe("sent");
    const r2 = await runPostWorkoutForActivity(p, b, {
      verifyCompletedToday: true,
    });
    // The decline is the twin check's, not the claim's: the claim is keyed on
    // the activity id and b was never claimed at all.
    expect(r2).toEqual({ failed: false, outcome: "twin-announced" });
    expect(postWorkoutClaimState(p, b)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // b's one-shot is NOT burned (#2570): a later merge may make it the keeper.
    expect(marker(p, b)).toBeNull();
  });

  it("a row's own stamped marker answers before the claim does", async () => {
    stubFetch();
    const p = newProfile("PWC-marker-first");
    const a = seedSession(p, "marker-first");
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    const again = await runPostWorkoutForActivity(p, a, {
      verifyCompletedToday: true,
    });
    expect(again).toEqual({ failed: false, outcome: "already-announced" });
  });
});
