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
import { markTaken, dismissItem } from "@/app/(app)/upcoming/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

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
