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
import { db } from "@/lib/db";
import { POST } from "@/app/api/offline-replay/route";
import { createLogin, createProfile, actAs } from "./harness";
import type { QueuedIntent } from "@/lib/offline/queue";

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

    const date = "2026-07-10";
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
