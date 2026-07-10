// SERVER-ACTION TIER — Upcoming snooze/dismiss/restore.
//
// These write upcoming_dismissals rows scoped to the ACTIVE profile. Asserts the
// stored row shape (snooze vs dismiss), the upsert on re-snooze / dismiss-then-
// snooze, restore delete, revalidation, input guards, and per-profile scoping —
// all against the REAL throwaway temp DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  snoozeItem,
  dismissItem,
  restoreItem,
  markCarePlanDone,
} from "@/app/(app)/upcoming/actions";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

// Insert a care_plan_items row for a profile, returning its id.
function insertCarePlanItem(
  profileId: number,
  description: string,
  plannedDate: string | null,
  status: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO care_plan_items
           (profile_id, description, planned_date, status)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, description, plannedDate, status).lastInsertRowid
  );
}
function carePlanStatus(id: number): string | null {
  return (
    (
      db.prepare("SELECT status FROM care_plan_items WHERE id = ?").get(id) as
        { status: string | null } | undefined
    )?.status ?? null
  );
}

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

interface Row {
  profile_id: number;
  signal_key: string;
  snooze_until: string | null;
  dismissed_at: string | null;
}
function rows(profileId: number): Row[] {
  return db
    .prepare(
      "SELECT profile_id, signal_key, snooze_until, dismissed_at FROM upcoming_dismissals WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as Row[];
}

describe("snoozeItem", () => {
  it("stores a snooze until today+days for the acting profile and revalidates", async () => {
    const { profile } = seedActor();
    await snoozeItem(fd({ signal_key: "biomarker:ldl", days: 7 }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0].signal_key).toBe("biomarker:ldl");
    expect(r[0].snooze_until).toBe(shiftDateStr(today(profile.id), 7));
    expect(r[0].dismissed_at).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
  });

  it("re-snoozing upserts the same row (no duplicate) and moves the date", async () => {
    const { profile } = seedActor();
    await snoozeItem(fd({ signal_key: "dose:1", days: 1 }));
    await snoozeItem(fd({ signal_key: "dose:1", days: 30 }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0].snooze_until).toBe(shiftDateStr(today(profile.id), 30));
  });

  it("ignores a missing key or a non-positive duration", async () => {
    const { profile } = seedActor();
    await snoozeItem(fd({ signal_key: "", days: 7 }));
    await snoozeItem(fd({ signal_key: "dose:1", days: 0 }));
    expect(rows(profile.id)).toHaveLength(0);
  });
});

describe("dismissItem", () => {
  it("stores a dismissal (no snooze) for the acting profile", async () => {
    const { profile } = seedActor();
    await dismissItem(fd({ signal_key: "appointment:5" }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0].dismissed_at).not.toBeNull();
    expect(r[0].snooze_until).toBeNull();
  });

  it("snoozing a previously-dismissed item clears the dismissal (upsert)", async () => {
    const { profile } = seedActor();
    await dismissItem(fd({ signal_key: "goal:2" }));
    await snoozeItem(fd({ signal_key: "goal:2", days: 7 }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0].dismissed_at).toBeNull();
    expect(r[0].snooze_until).toBe(shiftDateStr(today(profile.id), 7));
  });
});

describe("restoreItem", () => {
  it("deletes the suppression row", async () => {
    const { profile } = seedActor();
    await dismissItem(fd({ signal_key: "refill:9" }));
    expect(rows(profile.id)).toHaveLength(1);

    await restoreItem(fd({ signal_key: "refill:9" }));
    expect(rows(profile.id)).toHaveLength(0);
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
  });
});

describe("markCarePlanDone (issue #84)", () => {
  it("marks the acting profile's care-plan item completed and revalidates", async () => {
    const { profile } = seedActor();
    const id = insertCarePlanItem(
      profile.id,
      "Repeat screening colonoscopy",
      "2026-09-01",
      "planned"
    );

    await markCarePlanDone(fd({ care_plan_item_id: id }));

    expect(carePlanStatus(id)).toBe("completed");
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
    expect(revalidate).toHaveBeenCalledWith("/care-plan");
  });

  it("ignores a missing id", async () => {
    const { profile } = seedActor();
    const id = insertCarePlanItem(
      profile.id,
      "Follow-up",
      "2026-09-01",
      "active"
    );
    await markCarePlanDone(fd({ care_plan_item_id: 0 }));
    expect(carePlanStatus(id)).toBe("active");
  });

  it("never touches another profile's care-plan item", async () => {
    const login = createLogin({ role: "admin" });
    const a = createProfile("CP-A", login.id);
    const b = createProfile("CP-B", login.id);
    const bItem = insertCarePlanItem(b.id, "B's plan", "2026-09-01", "planned");

    // Acting as A, a tampered id pointing at B's row is a no-op (WHERE profile_id).
    actAs(login, a);
    await markCarePlanDone(fd({ care_plan_item_id: bItem }));
    expect(carePlanStatus(bItem)).toBe("planned");
  });
});

describe("per-profile scoping", () => {
  it("writes/reads under the acting profile only — no cross-profile bleed", async () => {
    const login = createLogin({ role: "admin" });
    const a = createProfile("SUP-A", login.id);
    const b = createProfile("SUP-B", login.id);

    actAs(login, a);
    await snoozeItem(fd({ signal_key: "dose:1", days: 7 }));

    // The same login acting as B does not see A's row, and restoring under B does
    // not touch A's.
    actAs(login, b);
    expect(rows(b.id)).toHaveLength(0);
    await restoreItem(fd({ signal_key: "dose:1" }));

    expect(rows(a.id)).toHaveLength(1); // A's snooze untouched by B's restore
  });
});
