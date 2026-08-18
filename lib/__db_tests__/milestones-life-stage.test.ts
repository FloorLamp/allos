import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { gatherMilestoneInput } from "@/lib/milestones-db";
import { setStoredAge } from "@/lib/settings";

function profile(name: string, age: number): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setStoredAge(id, age);
  return id;
}

function activities(
  profileId: number,
  type: "cardio" | "strength",
  count: number
): void {
  const insert = db.prepare(
    "INSERT INTO activities (profile_id, date, type, title) VALUES (?, ?, ?, ?)"
  );
  for (let i = 0; i < count; i += 1) {
    insert.run(profileId, today(profileId), type, `${type} ${i + 1}`);
  }
}

function achievedGoal(
  profileId: number,
  title: string,
  exercise?: string
): void {
  db.prepare(
    `INSERT INTO goals
       (profile_id, title, status, exercise, metric)
     VALUES (?, ?, 'achieved', ?, ?)`
  ).run(profileId, title, exercise ?? null, exercise ? "weight" : null);
}

describe("milestone life-stage boundaries", () => {
  it("omits activity and goal milestones through early childhood", () => {
    const id = profile("Toddler", 2);
    activities(id, "cardio", 10);
    achievedGoal(id, "Legacy movement goal");

    expect(gatherMilestoneInput(id)).toMatchObject({
      totalWorkouts: 0,
      completedGoals: [],
    });
  });

  it("counts cardio but omits strength milestones below adolescence", () => {
    const id = profile("School age", 10);
    activities(id, "cardio", 10);
    activities(id, "strength", 10);
    achievedGoal(id, "Run around the park");
    achievedGoal(id, "Legacy squat goal", "Squat");

    expect(gatherMilestoneInput(id)).toMatchObject({
      totalWorkouts: 10,
      completedGoals: [{ title: "Run around the park" }],
    });
  });
});
