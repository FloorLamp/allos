// SERVER-ACTION TIER — endurance event plans write path (issue #839).
//
// Drives the real Server Actions (create / update / status / delete) against the in-memory
// SQLite handle with the auth boundary mocked (setup.ts). Pins: a create lands active with
// the distance converted to canonical km; a second active plan for the same discipline is
// refused; complete stamps the date + records a milestone; abandon frees the discipline;
// delete removes the row; and each write revalidates /training + /timeline.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createEndurancePlan,
  updateEndurancePlan,
  setEndurancePlanStatus,
  deleteEndurancePlan,
} from "@/app/(app)/training/endurance-actions";
import { getEndurancePlans } from "@/lib/endurance-plans";
import { seedActor } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => revalidate.mockClear());

describe("createEndurancePlan (#839)", () => {
  it("creates an active plan and revalidates", async () => {
    const { profile } = seedActor();
    const res = await createEndurancePlan(
      fd({
        event_name: "City Half",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "21.1",
        target_time: "1:45:00",
      })
    );
    expect(res.ok).toBe(true);

    const plans = getEndurancePlans(profile.id);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("active");
    expect(plans[0].discipline).toBe("run");
    // km-preference default → distance stored canonically as entered.
    expect(plans[0].targetDistanceKm).toBeCloseTo(21.1, 2);
    expect(plans[0].targetTimeSec).toBe(6300); // 1:45:00

    const paths = revalidate.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/training");
    expect(paths).toContain("/timeline");
  });

  it("refuses a second active plan for the same discipline", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({ discipline: "run", event_date: "2026-10-05", target_distance: "10" })
    );
    const dup = await createEndurancePlan(
      fd({
        discipline: "run",
        event_date: "2026-11-05",
        target_distance: "21.1",
      })
    );
    expect(dup.ok).toBe(false);
    expect(getEndurancePlans(profile.id)).toHaveLength(1);
  });

  it("refuses an invalid distance / missing date", async () => {
    seedActor();
    const bad = await createEndurancePlan(
      fd({ discipline: "run", event_date: "", target_distance: "0" })
    );
    expect(bad.ok).toBe(false);
  });
});

describe("updateEndurancePlan / status / delete (#839)", () => {
  it("edits a plan in place", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({ discipline: "run", event_date: "2026-10-05", target_distance: "10" })
    );
    const id = getEndurancePlans(profile.id)[0].id;
    const res = await updateEndurancePlan(
      fd({
        id: String(id),
        event_name: "Renamed",
        discipline: "run",
        event_date: "2026-10-12",
        target_distance: "12",
      })
    );
    expect(res.ok).toBe(true);
    const plan = getEndurancePlans(profile.id)[0];
    expect(plan.eventName).toBe("Renamed");
    expect(plan.eventDate).toBe("2026-10-12");
    expect(plan.targetDistanceKm).toBeCloseTo(12, 2);
  });

  it("completes a plan, stamps the date, records a milestone, and frees the discipline", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        event_name: "Test 10k",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "10",
      })
    );
    const id = getEndurancePlans(profile.id)[0].id;
    const res = await setEndurancePlanStatus(
      fd({ id: String(id), status: "completed" })
    );
    expect(res.ok).toBe(true);
    expect(getEndurancePlans(profile.id)[0].status).toBe("completed");

    const ms = db
      .prepare(
        "SELECT COUNT(*) AS n FROM milestones WHERE profile_id = ? AND key = ?"
      )
      .get(profile.id, `endurance-plan:${id}`) as { n: number };
    expect(ms.n).toBe(1);

    // Discipline freed → a new active run plan is allowed.
    const again = await createEndurancePlan(
      fd({
        discipline: "run",
        event_date: "2027-04-05",
        target_distance: "21.1",
      })
    );
    expect(again.ok).toBe(true);
  });

  it("abandons and deletes a plan", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        discipline: "ride",
        event_date: "2026-10-05",
        target_distance: "100",
      })
    );
    const id = getEndurancePlans(profile.id)[0].id;
    expect(
      (
        await setEndurancePlanStatus(
          fd({ id: String(id), status: "abandoned" })
        )
      ).ok
    ).toBe(true);
    expect(getEndurancePlans(profile.id)[0].status).toBe("abandoned");
    expect((await deleteEndurancePlan(fd({ id: String(id) }))).ok).toBe(true);
    expect(getEndurancePlans(profile.id)).toHaveLength(0);
  });
});
