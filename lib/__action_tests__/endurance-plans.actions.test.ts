// SERVER-ACTION TIER — endurance event plans write path (issue #839).
//
// Drives the real Server Actions (create / update / status / delete) against the in-memory
// SQLite handle with the auth boundary mocked (setup.ts). Pins: a create lands active with
// the distance converted to canonical km; a second active plan for the same discipline is
// refused; complete stamps the date + records a milestone; abandon frees the discipline;
// delete removes the row; and each write revalidates /training + /history.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createEndurancePlan,
  updateEndurancePlan,
  setEndurancePlanStatus,
  deleteEndurancePlan,
  linkEventActivity,
  unlinkEventActivity,
} from "@/app/(app)/training/endurance-actions";
import { getEndurancePlans } from "@/lib/endurance-plans";
import { seedActor } from "./harness";
import { setStoredAge } from "@/lib/settings";

const revalidate = vi.mocked(revalidatePath);

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => revalidate.mockClear());

describe("createEndurancePlan (#839)", () => {
  it("refuses a plan through early childhood", async () => {
    const { profile } = seedActor();
    setStoredAge(profile.id, 2);
    const res = await createEndurancePlan(
      fd({ discipline: "run", event_date: "2026-10-05" })
    );
    expect(res.ok).toBe(false);
    expect(getEndurancePlans(profile.id)).toEqual([]);
  });

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
    expect(paths).toContain("/history");
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

  // The trap #2573 removes, pinned as a PROPERTY rather than as a list of the columns
  // that happen to exist today: enumerate the plan row's real columns and require every
  // one of them to survive an edit that does not name it. Add a column, write it from the
  // update core, and forget to carry it through `mergePatch` — this fails, where a list of
  // per-field assertions could only ever pin the fields its author knew about.
  //
  // No exemptions: the fixture reaches a state where EVERY column holds a real value, so
  // nothing can pass by sitting at its default. `notes` and `session_kinds` have no write
  // path at all (no control carries them; v1 reserved the second), which is exactly why
  // they are the columns worth pinning — they are set here directly.
  it("leaves every column a partial edit does not name exactly as it was", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        event_name: "City Half",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "21.1",
        target_time: "1:45:00",
      })
    );
    const id = getEndurancePlans(profile.id)[0].id;
    // Completing stamps completed_on; a completed plan is still editable (only an ACTIVE
    // one can collide on the one-active-per-discipline rule).
    await setEndurancePlanStatus(fd({ id: String(id), status: "completed" }));
    // The two columns nothing writes. Set directly, because the point of the census is
    // that a column with no form control is still a column an edit must not clear.
    db.prepare(
      "UPDATE endurance_plans SET notes = ?, session_kinds = ? WHERE id = ?"
    ).run("tempo Tuesdays, long run Sunday", '["tempo","long"]', id);

    const columns = (
      db.prepare("PRAGMA table_info(endurance_plans)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    const readRow = () =>
      db
        .prepare("SELECT * FROM endurance_plans WHERE id = ?")
        .get(id) as Record<string, unknown>;
    const before = readRow();

    // Guard the census itself: a column sitting at its default proves nothing about
    // having been preserved, so the fixture above must give every column a value.
    for (const c of columns) {
      expect(
        before[c],
        `fixture leaves endurance_plans.${c} empty — give it a value`
      ).not.toBeNull();
    }

    // Correct ONE field. Every other column is then in the protected set — a request that
    // also named `target_time` would prove nothing about `target_time`, which is why this
    // names the minimum the action requires (an id, the validated discipline) plus the one
    // value under edit, rather than a plausible form's whole control set.
    const res = await updateEndurancePlan(
      fd({
        id: String(id),
        event_name: "City Half Marathon",
        discipline: "run",
      })
    );
    expect(res.ok).toBe(true);

    const after = readRow();
    expect(after.event_name).toBe("City Half Marathon");
    for (const c of columns) {
      if (c === "event_name") continue;
      expect(
        after[c],
        `endurance_plans.${c} was changed by an edit that never named it`
      ).toEqual(before[c]);
    }
  });

  // An edit that carries no control for a field leaves it alone; one that carries the
  // control blank still means "clear this". The `has()` test, from the caller's side.
  it("clears a field the form carries blank, and leaves the ones it never carries", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        event_name: "City Half",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "21.1",
        target_time: "1:45:00",
      })
    );
    const id = getEndurancePlans(profile.id)[0].id;
    db.prepare("UPDATE endurance_plans SET notes = ? WHERE id = ?").run(
      "keep me",
      id
    );

    const res = await updateEndurancePlan(
      fd({ id: String(id), event_name: "", discipline: "run" })
    );
    expect(res.ok).toBe(true);
    const plan = getEndurancePlans(profile.id)[0];
    expect(plan.eventName).toBeNull(); // carried, blank → cleared
    expect(plan.notes).toBe("keep me"); // never carried → untouched
    expect(plan.eventDate).toBe("2026-10-05"); // likewise
    expect(plan.targetTimeSec).toBe(6300);
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

// The manual link (#3285 item 2), from the caller's side: the day rule (attach only)
// and the profile scope are the core's, and the action answers from what happened.
describe("linkEventActivity / unlinkEventActivity (#3285 item 2)", () => {
  it("links a same-day activity, refuses another day's and another profile's, and unlinks", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        event_name: "Harbor 10k",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "10",
      })
    );
    const id = String(getEndurancePlans(profile.id)[0].id);
    const insert = db.prepare(
      `INSERT INTO activities (profile_id, date, type, title)
       VALUES (?, ?, 'cardio', 'Running')`
    );
    const onDay = String(insert.run(profile.id, "2026-10-05").lastInsertRowid);
    const eve = String(insert.run(profile.id, "2026-10-04").lastInsertRowid);
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Other')").run()
        .lastInsertRowid
    );
    const theirs = String(insert.run(other, "2026-10-05").lastInsertRowid);
    const linkOf = (activityId: string) =>
      (
        db
          .prepare("SELECT endurance_plan_id AS p FROM activities WHERE id = ?")
          .get(activityId) as { p: number | null }
      ).p;

    expect((await linkEventActivity(fd({ id, activity_id: eve }))).ok).toBe(
      false
    );
    expect((await linkEventActivity(fd({ id, activity_id: theirs }))).ok).toBe(
      false
    );
    revalidate.mockClear();
    expect((await linkEventActivity(fd({ id, activity_id: onDay }))).ok).toBe(
      true
    );
    expect([linkOf(onDay), linkOf(eve), linkOf(theirs)]).toEqual([
      Number(id),
      null,
      null,
    ]);
    expect(revalidate.mock.calls.map((c) => c[0])).toContain(
      "/training/event/[id]"
    );

    expect((await unlinkEventActivity(fd({ activity_id: onDay }))).ok).toBe(
      true
    );
    expect(linkOf(onDay)).toBeNull();
    // Nothing to unlink is a refusal, not a confirmation.
    expect((await unlinkEventActivity(fd({ activity_id: onDay }))).ok).toBe(
      false
    );
  });

  // Detaching carries no day rule (the attach does). Whichever side's date moved
  // since the link was made — the organiser postponing, a provider re-sending the
  // session with a corrected start time, the person fixing the day they logged it —
  // the person can still take the result off the event.
  it("unlinks a result the event's date has moved away from", async () => {
    const { profile } = seedActor();
    await createEndurancePlan(
      fd({
        event_name: "Harbor 10k",
        discipline: "run",
        event_date: "2026-10-05",
        target_distance: "10",
      })
    );
    const plan = getEndurancePlans(profile.id)[0];
    const id = String(plan.id);
    const activityId = String(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title)
           VALUES (?, '2026-10-05', 'cardio', 'Harbor 10k')`
        )
        .run(profile.id).lastInsertRowid
    );
    expect(
      (await linkEventActivity(fd({ id, activity_id: activityId }))).ok
    ).toBe(true);

    await updateEndurancePlan(
      fd({
        id,
        event_name: "Harbor 10k",
        discipline: "run",
        event_date: "2026-10-12",
        target_distance: "10",
      })
    );
    revalidate.mockClear();
    expect(
      (await unlinkEventActivity(fd({ activity_id: activityId }))).ok
    ).toBe(true);
    expect(
      db
        .prepare("SELECT endurance_plan_id AS p FROM activities WHERE id = ?")
        .get(activityId)
    ).toEqual({ p: null });
    expect(revalidate.mock.calls.map((c) => c[0])).toContain(
      "/training/event/[id]"
    );

    // Nothing left to unlink, and the message says only that.
    expect(await unlinkEventActivity(fd({ activity_id: activityId }))).toEqual({
      ok: false,
      error: "That activity isn’t linked to an event.",
    });
  });
});
