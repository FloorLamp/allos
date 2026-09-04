// DB INTEGRATION TIER — the fold corrects the recap it already announced (#4996).
//
// THE OWNER REPORT (2026-09-03): "why did I get a generic workout complete
// notification today". Traced on a prod snapshot the same afternoon, and the sequence
// this file replays is that trace:
//
//   14:11:53  two Health Connect rows for the morning ride land, untyped
//   15:04     the ride ends
//   15:16:39  the finish dispatch announces the Health Connect row: "Session complete"
//             with the `actype` type-ask keyboard
//   15:50:02  Strava's sync brings the ride; the auto-merge folds all four and keeps
//             the Strava row under a NEW id
//   after     carryPostWorkoutMarker carries the announcement onto the keeper, so the
//             good row is never announced
//
// That last step is #2570 working — one ride, one message — and NOTHING here may make a
// second send. Every case asserts on the send count as well as on the edit, because a
// "fix" that announced the keeper would satisfy every assertion about the corrected
// TEXT while breaking the invariant the text is riding on.
//
// The cases go through the real send chokepoint (so the pointer and its body hash are
// recorded exactly as production records them) and the real reconcile sweep, with only
// the raw Telegram transport stubbed. Every value is synthetic: fictional external ids,
// a fake chat id, no PHI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today, writeTx } from "@/lib/db";
import { getProfileSetting } from "@/lib/settings";
import { setTelegramBotConfig } from "@/lib/settings";
import { runPostWorkoutForActivity } from "@/lib/notifications/workout-presence";
import { postWorkoutFinishMarkerKey } from "@/lib/notifications/post-workout-marker";
import { rebuildWorkoutRecap } from "@/lib/notifications/workout-recap-build";
import { STRAVA_DETAILS_FOLLOW_LINE } from "@/lib/notifications/workout-recap-format";
import { ACTIVITY_TYPE_ASK_PROMPT } from "@/lib/notifications/workout-recap-format";
import { autoMergeActivityDuplicates } from "@/lib/import-review/auto-merge";
import { writeActivityFold } from "@/lib/merge-activity";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { liveMessagePointers } from "@/lib/notifications/message-pointers";
import { messageBodyHash } from "@/lib/notifications/reconcile-core";
import { composeForSend } from "@/lib/notifications/compose";
import { plainBody } from "@/lib/notifications/rich-text";
import {
  editMessageTextRaw,
  sendMessageRaw,
  stubTelegramSends,
} from "./telegram-spies";
import { seedLoginTelegram } from "./fixtures";

// 15:16 UTC on the day of the trace — the finish dispatch.
const NOW = new Date("2026-07-17T15:16:39Z");
let chatSeq = 8800000;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  seedLoginTelegram(id, String(chatSeq++));
  return id;
}

function connectStrava(profileId: number): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, source_id, status, config)
     VALUES (?, 'strava', 'connected', NULL)`
  ).run(profileId);
}

interface RideOpts {
  source: string;
  externalId: string;
  type?: string;
  title?: string;
  start?: string;
  end?: string;
  distanceKm?: number;
  avgHr?: number | null;
  maxHr?: number | null;
  elevationM?: number | null;
}

// One imported copy of the morning ride, in the profile's wall clock.
function seedRide(profileId: number, opts: RideOpts): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            distance_km, avg_hr, max_hr, elevation_m, source, external_id)
         VALUES (?, ?, ?, ?, ?, ?, 51, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        today(profileId),
        opts.type ?? "unclassified",
        opts.title ?? "Workout",
        opts.start ?? "14:13",
        opts.end ?? "15:04",
        opts.distanceKm ?? 18.25,
        opts.avgHr ?? null,
        opts.maxHr ?? null,
        opts.elevationM ?? null,
        opts.source,
        opts.externalId
      ).lastInsertRowid
  );
}

/** The untyped Health Connect copy — the one that lands first and speaks. */
function seedHub(profileId: number, suffix = "a"): number {
  return seedRide(profileId, {
    source: "health-connect",
    externalId: `health-connect:fixture-ride-${suffix}`,
  });
}

/** The Strava copy: named, typed, and the one that wins the keeper contest. */
function seedStrava(profileId: number): number {
  return seedRide(profileId, {
    source: "strava",
    externalId: "strava:fixture-ride",
    type: "cardio",
    title: "Morning Ride",
    avgHr: 137,
    maxHr: 158,
    elevationM: 220,
  });
}

function row(id: number): Record<string, unknown> {
  return db.prepare("SELECT * FROM activities WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

/** The Review resolver's shape: fold the drop into the keeper, then delete it. */
function foldInto(profileId: number, keepId: number, dropId: number): void {
  writeTx(() => {
    writeActivityFold(profileId, keepId, row(keepId), [row(dropId)]);
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      dropId,
      profileId
    );
  });
}

function keeperLink(profileId: number, droppedId: number): string | null {
  return (
    getProfileSetting(profileId, `notify_recap_keeper_${droppedId}`) ?? null
  );
}

function sentClaims(profileId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM notify_post_workout_claims
          WHERE profile_id = ? AND state = 'sent'`
      )
      .get(profileId) as { n: number }
  ).n;
}

/** The one pointer the recap send recorded. */
function recapPointer(profileId: number) {
  const live = liveMessagePointers(profileId).filter(
    (p) => p.kind === "workout-recap"
  );
  expect(live).toHaveLength(1);
  return live[0];
}

/** The delivered message, as the raw transport received it: title and plain body. */
function sentText(index = 0): string {
  const msg = vi.mocked(sendMessageRaw).mock.calls[index][1];
  return `${msg.title}\n${plainBody(msg.body)}`;
}

function editedText(): string {
  return String(vi.mocked(editMessageTextRaw).mock.calls[0][2]);
}

function editedKeyboardTokens(): string[] {
  const opts = vi.mocked(editMessageTextRaw).mock.calls[0][3];
  return (opts?.keyboard ?? [])
    .flat()
    .map((b) => b.callback_data)
    .filter((d): d is string => typeof d === "string");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stubTelegramSends();
  vi.mocked(sendMessageRaw).mockClear();
  vi.mocked(editMessageTextRaw).mockClear();
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
  db.prepare("DELETE FROM notify_lifecycle").run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The send, before anything merges ─────────────────────────────────────────

describe("the unclassified send says details follow (#4996 item 3)", () => {
  it("carries the type ask AND the provisional line when Strava is connected", async () => {
    const p = newProfile("REC-provisional");
    connectStrava(p);
    const hub = seedHub(p);

    const out = await runPostWorkoutForActivity(p, hub, {
      verifyCompletedToday: true,
    });
    expect(out.outcome).toBe("sent");
    expect(sentClaims(p)).toBe(1);

    const text = sentText();
    expect(text).toContain("Session complete");
    expect(text).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(text).toContain(STRAVA_DETAILS_FOLLOW_LINE);

    // The pointer the sweep will work from: the kind now declares a prose reconciler,
    // so the chokepoint records a body hash for it (#1913 item 4's branch).
    const pointer = recapPointer(p);
    expect(pointer.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // #5001: the promise gains a MEASURED wait, or stays exactly as it was.
  //
  // Strava polls rather than pushes, so the wait is real and worth quoting — but only
  // where this profile's own arrivals say what it is. The pair below is the gate: five
  // arrivals quote it, four do not, and nothing in between invents a number.
  function seedStravaArrivals(
    profileId: number,
    lagMin: number,
    count: number
  ): void {
    const event = db.prepare(
      `INSERT INTO integration_sync_events (profile_id, source_id, at, ok, inserted)
       VALUES (?, 'strava', ?, 1, 1)`
    );
    const link = db.prepare(
      `INSERT INTO integration_sync_rows
         (event_id, target_table, target_id, disposition, created_at)
       VALUES (?, 'activities', ?, 'inserted', ?)`
    );
    for (let i = 1; i <= count; i++) {
      const rideId = seedRide(profileId, {
        source: "strava",
        externalId: `strava:arrival-${i}`,
        title: `Past ride ${i}`,
      });
      // seedRide dates every row today and ends it at 15:04 local (UTC here).
      const arrivedAt = new Date(
        Date.parse(`${today(profileId)}T15:04:00Z`) + lagMin * 60_000
      )
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
      const eventId = Number(event.run(profileId, arrivedAt).lastInsertRowid);
      link.run(eventId, rideId, arrivedAt);
    }
  }

  it("quotes the usual wait once this profile's Strava arrivals are measured", async () => {
    const p = newProfile("REC-measured-wait");
    connectStrava(p);
    seedStravaArrivals(p, 45, 5);
    const hub = seedHub(p);

    await runPostWorkoutForActivity(p, hub, { verifyCompletedToday: true });
    expect(sentText()).toContain(
      "Details follow when Strava syncs, usually within an hour."
    );
  });

  it("keeps the promise unquantified under the sample gate", async () => {
    const p = newProfile("REC-thin-wait");
    connectStrava(p);
    seedStravaArrivals(p, 45, 4);
    const hub = seedHub(p);

    await runPostWorkoutForActivity(p, hub, { verifyCompletedToday: true });
    const text = sentText();
    expect(text).toContain(STRAVA_DETAILS_FOLLOW_LINE);
    expect(text).not.toContain("usually within");
  });

  it("says nothing about details for a profile with no richer source", async () => {
    // Keyed on a FACT, never on "riders usually have Strava": a profile that will never
    // receive richer details is not told to wait for them. The type ask is its whole
    // state, exactly as before this issue.
    const p = newProfile("REC-no-source");
    const hub = seedHub(p);

    await runPostWorkoutForActivity(p, hub, { verifyCompletedToday: true });
    const text = sentText();
    expect(text).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(text).not.toContain(STRAVA_DETAILS_FOLLOW_LINE);
  });

  it("says nothing about details when the announced row IS the Strava row", async () => {
    // The line is a promise about a source that has not arrived. On a Strava row it
    // would be a promise about a sync that already happened.
    const p = newProfile("REC-already-strava");
    connectStrava(p);
    const strava = seedRide(p, {
      source: "strava",
      externalId: "strava:fixture-untyped",
      title: "Morning Ride",
    });

    await runPostWorkoutForActivity(p, strava, { verifyCompletedToday: true });
    const text = sentText();
    expect(text).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(text).not.toContain(STRAVA_DETAILS_FOLLOW_LINE);
  });
});

// ── #4996 item 4: order never matters ────────────────────────────────────────

describe("the four orderings (#4996 item 4)", () => {
  // ORDERING 2 — the prod trace. Health Connect first, Strava folds it away.
  it("HEALTH CONNECT FIRST: the fold registers and the sweep edits to the keeper", async () => {
    const p = newProfile("REC-hub-first");
    connectStrava(p);
    const hub = seedHub(p);
    await runPostWorkoutForActivity(p, hub, { verifyCompletedToday: true });
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);

    // 15:50 — Strava's sync brings the ride and the auto-merge collapses the cluster.
    vi.setSystemTime(new Date("2026-07-17T15:50:02Z"));
    const strava = seedStrava(p);
    expect(autoMergeActivityDuplicates(p)).toBeGreaterThan(0);
    expect(
      (
        db.prepare("SELECT id FROM activities WHERE profile_id = ?").all(p) as {
          id: number;
        }[]
      ).map((r) => r.id)
    ).toEqual([strava]);

    // #2570 still holds: the announcement moved to the keeper, so the good row is
    // never announced. And the follow-up now records WHERE it moved.
    expect(getProfileSetting(p, postWorkoutFinishMarkerKey(strava))).not.toBe(
      undefined
    );
    expect(keeperLink(p, hub)).toBe(String(strava));

    vi.mocked(editMessageTextRaw).mockClear();
    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(1);

    const text = editedText();
    // The keeper's own sentence, composed by the same builder the send ran.
    expect(text).toContain("Cardio complete");
    expect(text).toContain("Morning Ride done");
    expect(text).toContain("51 min");
    expect(text).toContain("18.25 km");
    expect(text).toContain("avg HR 137 (max 158)");
    // The ask and its provisional line are gone: the keeper is classified, so there is
    // nothing left to ask and nothing left to wait for.
    expect(text).not.toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(text).not.toContain(STRAVA_DETAILS_FOLLOW_LINE);
    expect(editedKeyboardTokens()).toEqual([]);

    // NO SECOND SEND, EVER. One send, one `sent` claim, and the correction was an edit.
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);
    expect(sentClaims(p)).toBe(1);
  });

  // ORDERING 1 — Strava first. The message is already the keeper's.
  it("STRAVA FIRST: nothing registers and nothing is edited", async () => {
    const p = newProfile("REC-strava-first");
    connectStrava(p);
    const strava = seedStrava(p);
    await runPostWorkoutForActivity(p, strava, { verifyCompletedToday: true });
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);

    const hub = seedHub(p);
    expect(autoMergeActivityDuplicates(p)).toBeGreaterThan(0);

    // The keeper carries its OWN marker, so no drop was the announced one: there is no
    // subject to move and nothing to register.
    expect(keeperLink(p, hub)).toBeNull();
    expect(keeperLink(p, strava)).toBeNull();

    vi.mocked(editMessageTextRaw).mockClear();
    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(0);
    expect(vi.mocked(editMessageTextRaw)).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);
  });

  // ORDERING 3 — a same-source twin fold, before Strava arrives.
  it("SAME-SOURCE FOLD: the rebuild runs and is a NO-OP BY BODY HASH", async () => {
    const p = newProfile("REC-same-source");
    connectStrava(p);
    const a = seedHub(p, "a");
    const b = seedHub(p, "b");
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    const pointer = recapPointer(p);

    // The auto-merge refuses a same-source group by design (#2570), so this fold is
    // the Review resolver's — the same writeActivityFold core, one entry point over.
    foldInto(p, b, a);
    expect(keeperLink(p, a)).toBe(String(b));

    // THE PROOF THAT THIS IS THE HASH PATH AND NOT "NOTHING HAPPENED": the rebuild
    // produced a real message for the KEEPER, and it hashes to what the chat is
    // already showing. A rebuild that had silently declined would be indistinguishable
    // from this by edit count alone.
    const rebuiltHash = () =>
      messageBodyHash(composeForSend(p, rebuildWorkoutRecap(p, pointer)!));
    const rebuilt = rebuildWorkoutRecap(p, pointer);
    expect(rebuilt).not.toBeNull();
    expect(plainBody(rebuilt!.body)).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(rebuiltHash()).toBe(pointer.bodyHash);

    // AND THE COMPARISON CAN FAIL — forged through the SAME pair the assertion above
    // reads, not through a fresh query written to check the work. A code-level mutation
    // cannot show this: the send and the rebuild are ONE builder by design, so anything
    // that changes the render changes both sides of the hash equally. Only a keeper that
    // genuinely says something else moves it, which is the whole question the pin asks.
    db.prepare("UPDATE activities SET title = 'Evening Ride' WHERE id = ?").run(
      b
    );
    expect(rebuiltHash()).not.toBe(pointer.bodyHash);
    db.prepare("UPDATE activities SET title = 'Workout' WHERE id = ?").run(b);
    expect(rebuiltHash()).toBe(pointer.bodyHash);

    vi.mocked(editMessageTextRaw).mockClear();
    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(0);
    expect(vi.mocked(editMessageTextRaw)).not.toHaveBeenCalled();

    // The keyboard still names the DELETED row, and that is the `actype` compare-and-
    // swap's job rather than this edit's (#2271): an edit that changed only the token
    // would spend a Telegram call on every twin fold to repoint a button whose own
    // handler already refuses a stale tap.
    expect(
      pointer.keyboard
        .flat()
        .map((btn) => btn.callback_data)
        .filter((d) => typeof d === "string")
    ).toEqual([
      `actype:${p}:${a}:strength`,
      `actype:${p}:${a}:cardio`,
      `actype:${p}:${a}:sport`,
    ]);
  });

  // ORDERING 3 CONTINUED — and then Strava arrives, two hops from the announced row.
  it("SAME-SOURCE FOLD THEN STRAVA: the chain reaches the keeper two hops away", async () => {
    // Two folds, written by two different merges, neither of which knew about the
    // other: the same-source twin pair resolved in Review, then the cross-source pair
    // resolved with the Strava row as keeper. The delivered message still names row A,
    // and the truth is now two hops along — which is why the redirect is a CHAIN.
    //
    // (The unattended auto-merge cannot supply the second hop here: writeActivityFold
    // marks its keeper `edited`, and an edit-locked member wins the auto keeper slot,
    // so a same-source fold followed by an auto-merge keeps the hub row. That case is
    // the "KEEPS the ask" one below.)
    const p = newProfile("REC-chain");
    connectStrava(p);
    const a = seedHub(p, "a");
    const b = seedHub(p, "b");
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    foldInto(p, b, a);

    vi.setSystemTime(new Date("2026-07-17T15:50:02Z"));
    const strava = seedStrava(p);
    foldInto(p, strava, b);
    expect(keeperLink(p, a)).toBe(String(b));
    expect(keeperLink(p, b)).toBe(String(strava));

    vi.mocked(editMessageTextRaw).mockClear();
    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(1);
    expect(editedText()).toContain("Morning Ride done");
    expect(editedText()).not.toContain(STRAVA_DETAILS_FOLLOW_LINE);
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);
    expect(sentClaims(p)).toBe(1);
  });
});

// ── The keeper that is still unclassified ────────────────────────────────────

describe("the ask is dropped or kept by what the keeper knows (#4996 item 2)", () => {
  it("KEEPS the ask, re-addressed to the keeper, when the keeper is unclassified", async () => {
    // A fold whose keeper is still untyped but genuinely richer — the same-source case
    // that DOES change the sentence. The question is still open, so it is still asked;
    // what must not survive is a keyboard naming a row that no longer exists.
    const p = newProfile("REC-keep-ask");
    const a = seedHub(p, "a");
    const b = seedRide(p, {
      source: "health-connect",
      externalId: "health-connect:fixture-ride-b",
      title: "Bike ride",
      avgHr: 137,
      maxHr: 158,
    });
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    foldInto(p, b, a);

    vi.mocked(editMessageTextRaw).mockClear();
    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(1);
    expect(editedText()).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(editedKeyboardTokens()).toEqual([
      `actype:${p}:${b}:strength`,
      `actype:${p}:${b}:cardio`,
      `actype:${p}:${b}:sport`,
    ]);
    expect(vi.mocked(sendMessageRaw)).toHaveBeenCalledTimes(1);
  });

  it("edits nothing for a profile with no richer source on a same-source fold", async () => {
    const p = newProfile("REC-no-source-fold");
    const a = seedHub(p, "a");
    const b = seedHub(p, "b");
    await runPostWorkoutForActivity(p, a, { verifyCompletedToday: true });
    foldInto(p, b, a);

    vi.mocked(editMessageTextRaw).mockClear();
    expect((await reconcileProfileMessages(p)).edited).toBe(0);
    expect(vi.mocked(editMessageTextRaw)).not.toHaveBeenCalled();
  });
});
