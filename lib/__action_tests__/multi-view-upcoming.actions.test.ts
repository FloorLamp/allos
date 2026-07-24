// SERVER-ACTION TIER — multi-view Upcoming per-item writes (issue #1096).
//
// On a multi-view Upcoming page every row carries its OWN profileId, and a per-item
// write (confirm a dose on Sam's row, dismiss Mia's refill) must land on the ITEM's
// profile while GATING on that profile's grant — never the acting one. Each write
// action posts `profile_id` and gates via gateItemProfile → requireProfileWriteAccess.
// This tier pins that gate: a GRANTED target's write lands on the target; an UNGRANTED
// or READ-ONLY target is refused BEFORE any write; and with no `profile_id` the action
// falls back to the acting profile. Auth is mocked (harness), the DB is real.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  markTaken,
  dismissItem,
  snoozeItem,
  restoreItem,
  markPreventiveDone,
  markCarePlanDone,
  overridePreventive,
  resolveFollowUp,
} from "@/app/(app)/upcoming/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// A valid preventive catalog rule key (recordPreventiveDone/setPreventiveOverride reject
// an unknown key before writing) — the adult annual physical.
const RULE_KEY = "adult_physical";

// A due supplement dose owned by `profileId`; returns the dose id.
function seedDose(profileId: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, priority, active, source, quantity_on_hand)
         VALUES (?, 'Vitamin D', 'daily', 'high', 1, 'manual', 30)`
      )
      .run(profileId).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '2000 IU', '08:00', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

function dismissalCount(profileId: number, signalKey: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
      )
      .get(profileId, signalKey) as { n: number }
  ).n;
}

function logCount(doseId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ?")
      .get(doseId) as { n: number }
  ).n;
}

describe("multi-view Upcoming per-item writes gate the ITEM's profile", () => {
  it("dismissItem lands on the ITEM's profile, not the acting one", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Acting", login.id);
    const target = createProfile("Target", login.id); // granted write
    actAs(login, acting);

    await dismissItem(fd({ signal_key: "dose:99", profile_id: target.id }));

    // The dismissal row is on the TARGET, never the acting profile.
    expect(dismissalCount(target.id, "dose:99")).toBe(1);
    expect(dismissalCount(acting.id, "dose:99")).toBe(0);
  });

  it("refuses a per-item write on an UNGRANTED profile (the refusal)", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Acting2", login.id);
    const stranger = createProfile("Stranger"); // NOT granted to this login
    actAs(login, acting);

    await expect(
      dismissItem(fd({ signal_key: "dose:1", profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(dismissalCount(stranger.id, "dose:1")).toBe(0);
  });

  it("refuses a per-item write on a READ-ONLY-granted profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Acting3", login.id);
    const ro = createProfile("ReadOnly"); // grant read-only explicitly
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(login.id, ro.id);
    actAs(login, acting);

    await expect(
      dismissItem(fd({ signal_key: "dose:2", profile_id: ro.id }))
    ).rejects.toThrow();
    expect(dismissalCount(ro.id, "dose:2")).toBe(0);
  });

  it("confirms a dose on a GRANTED cross-profile row (writes the target's log)", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Acting4", login.id);
    const target = createProfile("Target4", login.id); // granted write
    actAs(login, acting);
    const doseId = seedDose(target.id);

    await markTaken(fd({ dose_id: doseId, profile_id: target.id }));
    expect(logCount(doseId)).toBe(1);
  });

  it("without profile_id falls back to the acting profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Acting5", login.id);
    actAs(login, acting);

    await dismissItem(fd({ signal_key: "dose:5" }));
    expect(dismissalCount(acting.id, "dose:5")).toBe(1);
  });
});

// The rest of the per-item write gates (issue #1327 tests): snooze, restore,
// preventive-done, care-plan-done, preventive-override, follow-up-resolve. Before this
// only confirm (markTaken) + dismiss were covered; each gates the ITEM's profile through
// the SAME gateItemProfile → requireProfileWriteAccess, so each must (a) land a granted
// cross-profile write on the TARGET and (b) refuse an UNGRANTED target BEFORE any write.
describe("multi-view Upcoming — the remaining per-item write gates (issue #1327)", () => {
  function snoozeRow(
    profileId: number,
    signalKey: string
  ): { snooze_until: string | null } | undefined {
    return db
      .prepare(
        "SELECT snooze_until FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
      )
      .get(profileId, signalKey) as { snooze_until: string | null } | undefined;
  }

  function preventiveEventCount(profileId: number, ruleKey: string): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM preventive_events WHERE profile_id = ? AND rule_key = ?"
        )
        .get(profileId, ruleKey) as { n: number }
    ).n;
  }

  function overrideKind(
    profileId: number,
    ruleKey: string
  ): string | undefined {
    return (
      db
        .prepare(
          "SELECT kind FROM preventive_overrides WHERE profile_id = ? AND rule_key = ?"
        )
        .get(profileId, ruleKey) as { kind: string } | undefined
    )?.kind;
  }

  function seedCarePlanItem(profileId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO care_plan_items (profile_id, description, status, source)
           VALUES (?, 'Follow up with cardiology', 'active', 'manual')`
        )
        .run(profileId).lastInsertRowid
    );
  }

  function carePlanStatus(id: number): string | undefined {
    return (
      db.prepare("SELECT status FROM care_plan_items WHERE id = ?").get(id) as
        { status: string } | undefined
    )?.status;
  }

  // ── snoozeItem ──────────────────────────────────────────────────────────────
  it("snoozeItem lands on the ITEM's profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("SnoozeActing", login.id);
    const target = createProfile("SnoozeTarget", login.id);
    actAs(login, acting);

    await snoozeItem(
      fd({ signal_key: "biomarker-flag:LDL", days: 7, profile_id: target.id })
    );
    expect(
      snoozeRow(target.id, "biomarker-flag:LDL")?.snooze_until
    ).toBeTruthy();
    expect(snoozeRow(acting.id, "biomarker-flag:LDL")).toBeUndefined();
  });

  it("snoozeItem refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("SnoozeActing2", login.id);
    const stranger = createProfile("SnoozeStranger");
    actAs(login, acting);

    await expect(
      snoozeItem(fd({ signal_key: "x", days: 3, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(snoozeRow(stranger.id, "x")).toBeUndefined();
  });

  // ── restoreItem ─────────────────────────────────────────────────────────────
  it("restoreItem clears the suppression on the ITEM's profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("RestoreActing", login.id);
    const target = createProfile("RestoreTarget", login.id);
    actAs(login, acting);
    db.prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at) VALUES (?, 'dose:7', datetime('now'))"
    ).run(target.id);

    await restoreItem(fd({ signal_key: "dose:7", profile_id: target.id }));
    expect(dismissalCount(target.id, "dose:7")).toBe(0);
  });

  it("restoreItem refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("RestoreActing2", login.id);
    const stranger = createProfile("RestoreStranger");
    actAs(login, acting);
    db.prepare(
      "INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at) VALUES (?, 'dose:8', datetime('now'))"
    ).run(stranger.id);

    await expect(
      restoreItem(fd({ signal_key: "dose:8", profile_id: stranger.id }))
    ).rejects.toThrow();
    // The stranger's suppression survives — the gate fired before the delete.
    expect(dismissalCount(stranger.id, "dose:8")).toBe(1);
  });

  // ── markPreventiveDone ──────────────────────────────────────────────────────
  it("markPreventiveDone records the satisfaction on the ITEM's profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("PrevActing", login.id);
    const target = createProfile("PrevTarget", login.id);
    actAs(login, acting);

    await markPreventiveDone(fd({ rule_key: RULE_KEY, profile_id: target.id }));
    expect(preventiveEventCount(target.id, RULE_KEY)).toBe(1);
    expect(preventiveEventCount(acting.id, RULE_KEY)).toBe(0);
  });

  it("markPreventiveDone refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("PrevActing2", login.id);
    const stranger = createProfile("PrevStranger");
    actAs(login, acting);

    await expect(
      markPreventiveDone(fd({ rule_key: RULE_KEY, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(preventiveEventCount(stranger.id, RULE_KEY)).toBe(0);
  });

  // ── overridePreventive ──────────────────────────────────────────────────────
  it("overridePreventive writes the override on the ITEM's profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("OverActing", login.id);
    const target = createProfile("OverTarget", login.id);
    actAs(login, acting);

    await overridePreventive(
      fd({ rule_key: RULE_KEY, kind: "declined", profile_id: target.id })
    );
    expect(overrideKind(target.id, RULE_KEY)).toBe("declined");
    expect(overrideKind(acting.id, RULE_KEY)).toBeUndefined();
  });

  it("overridePreventive refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("OverActing2", login.id);
    const stranger = createProfile("OverStranger");
    actAs(login, acting);

    await expect(
      overridePreventive(
        fd({ rule_key: RULE_KEY, kind: "declined", profile_id: stranger.id })
      )
    ).rejects.toThrow();
    expect(overrideKind(stranger.id, RULE_KEY)).toBeUndefined();
  });

  // ── markCarePlanDone ────────────────────────────────────────────────────────
  it("markCarePlanDone completes the item on the ITEM's profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("CPActing", login.id);
    const target = createProfile("CPTarget", login.id);
    actAs(login, acting);
    const id = seedCarePlanItem(target.id);

    await markCarePlanDone(
      fd({ care_plan_item_id: id, profile_id: target.id })
    );
    expect(carePlanStatus(id)).toBe("completed");
  });

  it("markCarePlanDone refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("CPActing2", login.id);
    const stranger = createProfile("CPStranger");
    actAs(login, acting);
    const id = seedCarePlanItem(stranger.id);

    await expect(
      markCarePlanDone(fd({ care_plan_item_id: id, profile_id: stranger.id }))
    ).rejects.toThrow();
    expect(carePlanStatus(id)).toBe("active");
  });

  // ── resolveFollowUp ─────────────────────────────────────────────────────────
  // The gate runs before any write; a granted target with no matching follow-up returns
  // a friendly formError (gate PASSED), an ungranted target throws (gate REFUSED).
  it("resolveFollowUp passes the gate for a granted target (no-op formError)", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("FUActing", login.id);
    const target = createProfile("FUTarget", login.id);
    actAs(login, acting);

    const res = await resolveFollowUp(
      fd({
        care_plan_item_id: 999999,
        resolution: "resolved",
        profile_id: target.id,
      })
    );
    expect(res.ok).toBe(false);
  });

  it("resolveFollowUp refuses an UNGRANTED target", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("FUActing2", login.id);
    const stranger = createProfile("FUStranger");
    actAs(login, acting);

    await expect(
      resolveFollowUp(
        fd({
          care_plan_item_id: 5,
          resolution: "resolved",
          profile_id: stranger.id,
        })
      )
    ).rejects.toThrow();
  });
});
