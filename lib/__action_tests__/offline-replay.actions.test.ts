// SERVER-ACTION TIER — the offline replay route's PROFILE ATTRIBUTION (issue #599).
// The route is a cookie-authed Route Handler, not a Server Action, but it resolves
// the acting identity through the SAME lib/auth chokepoint the action tests mock
// (getCurrentSession / getAccessibleProfiles / accessForProfile, all faithful against
// the real temp DB), so this tier drives it end-to-end with a real login→profile grant
// matrix. It proves the fix for the cross-profile write:
//   (a) a stamped intent for profile B, replayed while acting as A with a WRITE grant
//       to B, lands on B — never on the active profile A;
//   (b) a stamped intent for a profile the login can't write is REJECTED, nothing
//       written (no silent reroute onto the active profile);
//   (c) the dose flow still applies, and its ownership check still rejects a dose that
//       isn't owned by the stamped profile;
//   (d) a LEGACY unstamped intent falls back to the active profile (backward compat).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { POST } from "@/app/api/offline-replay/route";
import { createLogin, createProfile, actAs } from "./harness";
import { shiftDateStr, utcSqlString, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import {
  STALE_QUEUED_DOSE_REASON,
  type QueuedIntent,
} from "@/lib/offline/queue";

let keySeq = 0;
function uniqueKey(): string {
  return `replay-test-${Date.now()}-${++keySeq}`;
}

async function replay(intents: unknown[]): Promise<{
  status: number;
  body: {
    ok: boolean;
    results?: { key: string; status: string; reason?: string }[];
  };
}> {
  const res = await POST(
    new Request("http://x/api/offline-replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intents }),
    })
  );
  return { status: res.status, body: await res.json() };
}

function bodyMetricIntent(
  profileId: number | undefined,
  notes: string
): QueuedIntent {
  return {
    key: uniqueKey(),
    flow: "body-metric",
    date: "2026-07-10",
    capturedAt: "2026-07-10T09:00:00.000Z",
    payload: {
      weight: "82",
      weightUnit: "kg",
      bodyFatPct: null,
      restingHr: null,
      notes,
    },
    ...(profileId === undefined ? {} : { profileId }),
    attempts: 0,
  };
}

function bodyMetricsFor(profileId: number, notes: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND notes = ?"
      )
      .get(profileId, notes) as { n: number }
  ).n;
}

describe("offline replay — profile attribution (issue #599)", () => {
  it("(a) applies a stamped intent to its CAPTURED profile, not the active one", async () => {
    // A caregiver member granted BOTH A and B (write), currently acting as A.
    const member = createLogin({ role: "member" });
    const profileA = createProfile("Replay A", member.id);
    const profileB = createProfile("Replay B", member.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { status, body } = await replay([
      bodyMetricIntent(profileB.id, notes),
    ]);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results?.[0].status).toBe("done");
    // The B-captured metric landed on B — and NOTHING landed on the active profile A.
    expect(bodyMetricsFor(profileB.id, notes)).toBe(1);
    expect(bodyMetricsFor(profileA.id, notes)).toBe(0);
  });

  it("(b) REJECTS a stamped intent for a profile the login can't write — nothing written", async () => {
    // Member granted ONLY A. B exists but is NOT theirs.
    const member = createLogin({ role: "member" });
    const profileA = createProfile("RejectA", member.id);
    const profileB = createProfile("RejectB"); // ungranted to this member
    actAs(member, profileA);

    const notes = uniqueKey();
    const { status, body } = await replay([
      bodyMetricIntent(profileB.id, notes),
    ]);

    expect(status).toBe(200); // per-intent honesty, not a blanket 4xx
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/permission/i);
    // Not applied to B (no access) AND not silently rerouted onto the active A.
    expect(bodyMetricsFor(profileB.id, notes)).toBe(0);
    expect(bodyMetricsFor(profileA.id, notes)).toBe(0);
  });

  it("(b2) REJECTS a stamped intent when the grant on the target is read-only", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("RoA", member.id);
    const profileB = createProfile("RoB", member.id);
    // Downgrade the member's grant on B to read-only.
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(member.id, profileB.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { body } = await replay([bodyMetricIntent(profileB.id, notes)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(bodyMetricsFor(profileB.id, notes)).toBe(0);
  });

  it("(c) applies a stamped DOSE intent to its captured profile, and ownership still gates it", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("DoseA", member.id);
    const profileB = createProfile("DoseB", member.id);
    actAs(member, profileA);

    // A dose owned by B.
    const itemB = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind)
           VALUES (?, 'Item B', 1, 'supplement')`
        )
        .run(profileB.id).lastInsertRowid
    );
    const doseB = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 cap', 'morning', 'any', 0, 0)`
        )
        .run(itemB).lastInsertRowid
    );

    // Today-anchored: the dose write cores bound how far a log may land from the
    // profile's today (#614), and since #1427 the replay rides those same cores.
    const date = today(profileB.id);
    const { body } = await replay([
      {
        key: uniqueKey(),
        flow: "dose",
        date,
        capturedAt: `${date}T09:00:00.000Z`,
        payload: { doseId: doseB },
        profileId: profileB.id,
        attempts: 0,
      },
    ]);
    expect(body.results?.[0].status).toBe("done");
    const logged = db
      .prepare("SELECT id FROM intake_item_logs WHERE dose_id = ? AND date = ?")
      .get(doseB, date);
    expect(logged).toBeTruthy();

    // A dose stamped to B but belonging to A is rejected by the ownership check even
    // though the login CAN write B.
    const itemA = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind)
           VALUES (?, 'Item A', 1, 'supplement')`
        )
        .run(profileA.id).lastInsertRowid
    );
    const doseA = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 cap', 'morning', 'any', 0, 0)`
        )
        .run(itemA).lastInsertRowid
    );
    const { body: body2 } = await replay([
      {
        key: uniqueKey(),
        flow: "dose",
        date,
        capturedAt: `${date}T09:00:00.000Z`,
        payload: { doseId: doseA },
        profileId: profileB.id,
        attempts: 0,
      },
    ]);
    expect(body2.results?.[0].status).toBe("rejected");
  });

  it("(d) a LEGACY unstamped intent falls back to the active profile (backward compat)", async () => {
    const member = createLogin({ role: "member" });
    const profileA = createProfile("LegacyA", member.id);
    actAs(member, profileA);

    const notes = uniqueKey();
    const { body } = await replay([bodyMetricIntent(undefined, notes)]);
    expect(body.results?.[0].status).toBe("done");
    expect(bodyMetricsFor(profileA.id, notes)).toBe(1);
  });
});

// ── #1427: the queued dose confirm rides the SHARED write core ────────────────
//
// Driven end-to-end through the route (cookie-authed, real grant matrix, real DB),
// because the whole point of the change is that the replay is no longer a private
// offline writer: it goes through markDoseTaken, so it inherits that core's typed
// refusals (retired dose, PAUSED item, the other resolution already standing) and
// its per-(dose,date) idempotency — and those refusals must reach the client with a
// reason, never be reported as synced.
describe("offline replay — dose confirms (issue #1427)", () => {
  function seedItem(
    profileId: number,
    opts: { active?: number; quantityOnHand?: number | null } = {}
  ): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, quantity_on_hand, qty_per_dose)
           VALUES (?, ?, ?, 'medication', ?, 1)`
        )
        .run(
          profileId,
          `Replay Med ${uniqueKey()}`,
          opts.active ?? 1,
          opts.quantityOnHand ?? null
        ).lastInsertRowid
    );
  }

  function seedDose(itemId: number, retired = 0): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
           VALUES (?, '1 tab', 'morning', 'any', 0, ?)`
        )
        .run(itemId, retired).lastInsertRowid
    );
  }

  function doseIntent(
    doseId: number,
    profileId: number,
    date: string,
    clientTakenAt?: string
  ) {
    return {
      key: uniqueKey(),
      flow: "dose" as const,
      date,
      capturedAt: new Date().toISOString(),
      payload: { doseId, ...(clientTakenAt ? { clientTakenAt } : {}) },
      profileId,
      attempts: 0,
    };
  }

  function logFor(doseId: number, date: string) {
    return db
      .prepare(
        "SELECT status, amount, given_at FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as
      | { status: string; amount: string | null; given_at: string | null }
      | undefined;
  }

  it("lands the confirm stamped with the CAPTURED tap time, not the replay time", async () => {
    const admin = createLogin();
    const profile = createProfile(`TakenAt ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { quantityOnHand: 12 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);
    // Local midnight of the log's own day: inside the day in the profile timezone and
    // (bar the first instant of the day) hours before the replay, so a stored given_at
    // matching it could not have come from the server's own clock.
    const tapped = zonedWallTimeToUtc(getTimezone(profile.id), date, "00:00");

    const { body } = await replay([
      doseIntent(doseId, profile.id, date, tapped.toISOString()),
    ]);
    expect(body.results?.[0].status).toBe("done");

    const log = logFor(doseId, date);
    expect(log?.status).toBe("taken");
    expect(log?.amount).toBe("1 tab"); // amount snapshotted from the dose row at replay
    expect(log?.given_at).toBe(utcSqlString(tapped));
    // Supply moved through the same core, exactly once.
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(11);
  });

  it("surfaces the PAUSED-item refusal instead of silently confirming", async () => {
    const admin = createLogin();
    const profile = createProfile(`Paused ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { active: 0, quantityOnHand: 5 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/paused/i);
    expect(logFor(doseId, date)).toBeUndefined();
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(5);
  });

  it("surfaces the retired-dose refusal with a reason", async () => {
    const admin = createLogin();
    const profile = createProfile(`Retired ${uniqueKey()}`);
    actAs(admin, profile);
    const doseId = seedDose(seedItem(profile.id), 1);
    const date = today(profile.id);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/no longer on the schedule/i);
    expect(logFor(doseId, date)).toBeUndefined();
  });

  it("resolves an already-confirmed dose as already-done, never a second log", async () => {
    const admin = createLogin();
    const profile = createProfile(`Idempotent ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id, { quantityOnHand: 9 });
    const doseId = seedDose(itemId);
    const date = today(profile.id);

    const first = doseIntent(doseId, profile.id, date);
    expect((await replay([first])).body.results?.[0].status).toBe("done");
    // The SAME idempotency key (a racing flush / Background Sync) → duplicate.
    expect((await replay([first])).body.results?.[0].status).toBe("duplicate");
    // A DIFFERENT key for the same dose+day (a re-tap queued while still offline) is
    // already-done: settled, not dead-lettered, and not a duplicate log row.
    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("done");
    expect(body.results?.[0].reason).toBeUndefined();

    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ? AND date = ?"
          )
          .get(doseId, date) as { n: number }
      ).n
    ).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?"
          )
          .get(itemId) as { q: number }
      ).q
    ).toBe(8);
  });

  it("refuses to overwrite a deliberate skip, and says why", async () => {
    const admin = createLogin();
    const profile = createProfile(`Skipped ${uniqueKey()}`);
    actAs(admin, profile);
    const itemId = seedItem(profile.id);
    const doseId = seedDose(itemId);
    const date = today(profile.id);
    db.prepare(
      "INSERT INTO intake_item_logs (dose_id, item_id, date, amount, status) VALUES (?,?,?,NULL,'skipped')"
    ).run(doseId, itemId, date);

    const { body } = await replay([doseIntent(doseId, profile.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toMatch(/already recorded as skipped/i);
    expect(logFor(doseId, date)?.status).toBe("skipped");
  });

  it("rejects a dose id belonging to ANOTHER profile, writing nothing", async () => {
    const admin = createLogin();
    const mine = createProfile(`Mine ${uniqueKey()}`);
    const theirs = createProfile(`Theirs ${uniqueKey()}`);
    actAs(admin, mine);
    const foreignDose = seedDose(seedItem(theirs.id));
    const date = today(mine.id);

    // Stamped to MY profile, but the dose is someone else's — the core's ownership
    // check (via the dose row's own item) refuses it.
    const { body } = await replay([doseIntent(foreignDose, mine.id, date)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(logFor(foreignDose, date)).toBeUndefined();
  });

  it("dead-letters an entry that outlived the dose-log window rather than backdating it", async () => {
    const admin = createLogin();
    const profile = createProfile(`Stale ${uniqueKey()}`);
    actAs(admin, profile);
    const doseId = seedDose(seedItem(profile.id));
    const longAgo = shiftDateStr(today(profile.id), -30);

    const { body } = await replay([doseIntent(doseId, profile.id, longAgo)]);
    expect(body.results?.[0].status).toBe("rejected");
    expect(body.results?.[0].reason).toBe(STALE_QUEUED_DOSE_REASON);
    expect(logFor(doseId, longAgo)).toBeUndefined();
  });
});
