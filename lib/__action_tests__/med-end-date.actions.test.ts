// SERVER-ACTION TIER — the medication End-date lifecycle field (#1140 Part D) and the
// single-med Restart (#1140 Part C), driven through the real Server Actions against the
// throwaway in-memory DB. The edit-form End date is bound to the current course's
// stopped_on under the active=1 ⇔ open-course invariant; setting it stops the med AS OF
// that date, clearing it reactivates — both through the SHARED stop/restart cores (never a
// raw stopped_on write), so this path and the Stop/Restart buttons produce identical
// course state (#221).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import {
  stopMedication,
  restartMedication,
} from "@/app/(app)/medications/actions";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "./harness";

vi.mocked(revalidatePath);
beforeEach(() => seedActor());

function lastItemId(): number {
  return Number(
    (
      db.prepare("SELECT MAX(id) AS id FROM intake_items").get() as {
        id: number;
      }
    ).id
  );
}
function latestCourse(itemId: number): {
  active: number;
  stopped_on: string | null;
} {
  const active = (
    db.prepare("SELECT active FROM intake_items WHERE id = ?").get(itemId) as {
      active: number;
    }
  ).active;
  const c = db
    .prepare(
      "SELECT stopped_on FROM medication_courses WHERE item_id = ? ORDER BY started_on DESC, id DESC LIMIT 1"
    )
    .get(itemId) as { stopped_on: string | null };
  return { active, stopped_on: c.stopped_on };
}
function courseCount(itemId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?")
      .get(itemId) as { n: number }
  ).n;
}

async function addActiveMed(name = "Lisinopril"): Promise<number> {
  const start = shiftDateStr(today(0), -10);
  await addSupplement(
    fd({ name, kind: "medication", rx: "1", started_on: start })
  );
  return lastItemId();
}
function courseId(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT id FROM medication_courses WHERE item_id = ? ORDER BY started_on DESC, id DESC LIMIT 1"
      )
      .get(itemId) as { id: number }
  ).id;
}

describe("edit-form End date (#1140 Part D)", () => {
  it("setting an End date stops the med AS OF that date (not today), flipping active→0", async () => {
    const id = await addActiveMed();
    const finishedOn = shiftDateStr(today(0), -3);
    const res = await updateSupplement(
      fd({
        id,
        name: "Lisinopril",
        kind: "medication",
        started_on: shiftDateStr(today(0), -10),
        course_id: courseId(id),
        end_date: finishedOn,
      })
    );
    expect(res.ok).toBe(true);
    const s = latestCourse(id);
    expect(s.active).toBe(0);
    expect(s.stopped_on).toBe(finishedOn); // the real finish day, not today
  });

  it("clearing the End date reactivates the med (active=1, an open course)", async () => {
    const id = await addActiveMed("Metformin");
    // Stop it via the Stop button first.
    await stopMedication(fd({ id, stop_reason: "other" }));
    expect(latestCourse(id).active).toBe(0);
    // Clear the End date on the edit form → active again.
    const res = await updateSupplement(
      fd({
        id,
        name: "Metformin",
        kind: "medication",
        started_on: shiftDateStr(today(0), -10),
        course_id: courseId(id),
        end_date: "",
      })
    );
    expect(res.ok).toBe(true);
    const s = latestCourse(id);
    expect(s.active).toBe(1);
    expect(s.stopped_on).toBeNull();
  });

  it("the form End-date path and the Stop button produce identical course state (#221)", async () => {
    const stopDay = today(0);
    // Via the Stop button.
    const a = await addActiveMed("DrugA");
    await stopMedication(fd({ id: a, stop_reason: "other" }));
    const viaButton = latestCourse(a);
    // Via the edit-form End date (set to today).
    const b = await addActiveMed("DrugB");
    await updateSupplement(
      fd({
        id: b,
        name: "DrugB",
        kind: "medication",
        started_on: shiftDateStr(today(0), -10),
        course_id: courseId(b),
        end_date: stopDay,
      })
    );
    const viaForm = latestCourse(b);
    expect(viaForm.active).toBe(viaButton.active);
    expect(viaForm.stopped_on).toBe(viaButton.stopped_on);
  });

  it("an unchanged End date is a no-op — no spurious course churn", async () => {
    const id = await addActiveMed("DrugC");
    const before = courseCount(id);
    await updateSupplement(
      fd({
        id,
        name: "DrugC",
        kind: "medication",
        started_on: shiftDateStr(today(0), -10),
        course_id: courseId(id),
        end_date: "", // already active/open → no transition
      })
    );
    expect(courseCount(id)).toBe(before);
    expect(latestCourse(id).active).toBe(1);
  });
});

describe("single-med Restart (#1140 Part C)", () => {
  it("restartMedication reactivates a stopped med through the shared restart core", async () => {
    const id = await addActiveMed("DrugD");
    await stopMedication(fd({ id, stop_reason: "other" }));
    expect(latestCourse(id).active).toBe(0);
    const res = await restartMedication(fd({ id }));
    expect(res.ok).toBe(true);
    const s = latestCourse(id);
    expect(s.active).toBe(1);
    expect(s.stopped_on).toBeNull();
  });
});
