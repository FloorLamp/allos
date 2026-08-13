// SERVER-ACTION TIER — the #2024 movement-aware injury constraint.
//
// Drives the real Server Actions against the in-memory SQLite handle with the auth
// boundary mocked (setup.ts). Pins: the declared precision round-trips through the write
// core and the read shaping; enum/identity inputs are validated at the boundary (a bogus
// side, a bogus pattern, an out-of-range factor are dropped, not stored); a raw exercise
// label is normalized to its canonical identity; the write core is profile-scoped; and a
// pre-#2024 row (all new columns NULL) still reads back as a region-scoped constraint.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  logInjury,
  setInjuryStatus,
  updateInjury,
} from "@/app/(app)/training/injury-actions";
import { getInjuries, getInjuryConstraints } from "@/lib/injuries";
import { exerciseInjuryVerdict } from "@/lib/injury-model";
import { exerciseHistoryKey } from "@/lib/lifts";
import { seedActor } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function injuryForm(
  fields: Record<string, string>,
  lists: {
    regions?: string[];
    movements?: string[];
    exercises?: string[];
    muscles?: string[];
  } = {}
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const r of lists.regions ?? []) form.append("regions", r);
  for (const m of lists.movements ?? []) form.append("movements", m);
  for (const e of lists.exercises ?? []) form.append("exercises", e);
  for (const m of lists.muscles ?? []) form.append("muscles", m);
  return form;
}

beforeEach(() => revalidate.mockClear());

describe("the declared precision round-trips (#2024)", () => {
  it("stores side, movements, load preference and review date", async () => {
    const { profile } = seedActor();
    const res = await logInjury(
      injuryForm(
        {
          label: "left knee",
          status: "recovering",
          laterality: "left",
          loadFactor: "0.8",
          reviewDate: "2026-10-01",
        },
        { regions: ["Legs"], movements: ["legs"] }
      )
    );
    expect(res.ok).toBe(true);

    const [row] = getInjuries(profile.id);
    expect(row.laterality).toBe("left");
    expect(row.movements).toEqual(["legs"]);
    expect(row.loadFactor).toBe(0.8);
    expect(row.reviewDate).toBe("2026-10-01");

    const [c] = getInjuryConstraints(profile.id);
    expect(c.scope).toBe("movement");
    // The user's preference reaches the engine's verdict, not the app's fallback.
    const v = exerciseInjuryVerdict([c], "Back Squat");
    expect(v.kind).toBe("tempered");
    expect(v.factor).toBe(0.8);
    expect(v.fallback).toBe(false);
  });

  it("normalizes a raw exercise label to its canonical identity", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "elbow", status: "active" },
        { regions: ["Arms"], exercises: ["Barbell Curl"] }
      )
    );
    const [row] = getInjuries(profile.id);
    expect(row.exercises).toEqual([exerciseHistoryKey("Barbell Curl")]);
    // …so the constraint matches the merged lift under any of its spellings.
    const [c] = getInjuryConstraints(profile.id);
    expect(exerciseInjuryVerdict([c], "Curl").kind).toBe("excluded");
  });

  it("an exercise-scoped constraint leaves its region alone end to end", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "right shoulder", status: "active" },
        { regions: ["Chest"], exercises: ["Bench Press"] }
      )
    );
    const constraints = getInjuryConstraints(profile.id);
    expect(exerciseInjuryVerdict(constraints, "Bench Press").kind).toBe(
      "excluded"
    );
    expect(exerciseInjuryVerdict(constraints, "Cable Fly").kind).toBe("clear");
  });
});

describe("boundary validation refuses bad input rather than storing it", () => {
  it("drops an unknown side and an unknown movement pattern", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "knee", laterality: "sideways" },
        {
          regions: ["Legs"],
          movements: ["legs", "levitate"],
        }
      )
    );
    const [row] = getInjuries(profile.id);
    expect(row.laterality).toBeNull();
    expect(row.movements).toEqual(["legs"]);
  });

  it("refuses an out-of-range load preference instead of clamping it", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "knee", status: "recovering", loadFactor: "9" },
        { regions: ["Legs"] }
      )
    );
    const [row] = getInjuries(profile.id);
    // Null ⇒ the app's disclosed fallback applies; nothing silently became 100%.
    expect(row.loadFactor).toBeNull();
  });

  it("drops a malformed review date", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "knee", reviewDate: "next tuesday" },
        {
          regions: ["Legs"],
        }
      )
    );
    expect(getInjuries(profile.id)[0].reviewDate).toBeNull();
  });

  it("keeps a load preference only while recovering", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "knee", status: "active", loadFactor: "0.5" },
        { regions: ["Legs"] }
      )
    );
    expect(getInjuries(profile.id)[0].loadFactor).toBeNull();
  });
});

describe("status changes never rewrite what the user declared", () => {
  it("leaving recovering clears the load preference and keeps everything else", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        {
          label: "left knee",
          status: "recovering",
          laterality: "left",
          loadFactor: "0.5",
          reviewDate: "2026-10-01",
        },
        { regions: ["Legs"], movements: ["legs"] }
      )
    );
    const id = getInjuries(profile.id)[0].id;

    const form = new FormData();
    form.set("id", String(id));
    form.set("status", "active");
    expect((await setInjuryStatus(form)).ok).toBe(true);

    const [row] = getInjuries(profile.id);
    expect(row.status).toBe("active");
    expect(row.loadFactor).toBeNull(); // only meaningful while recovering
    expect(row.laterality).toBe("left"); // untouched
    expect(row.movements).toEqual(["legs"]); // untouched
    expect(row.reviewDate).toBe("2026-10-01"); // untouched
  });

  it("an edit can widen a constraint back to its region", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "shoulder", status: "active" },
        {
          regions: ["Chest"],
          movements: ["push"],
        }
      )
    );
    const id = getInjuries(profile.id)[0].id;
    expect(getInjuryConstraints(profile.id)[0].scope).toBe("movement");

    await updateInjury(
      injuryForm(
        { id: String(id), label: "shoulder", status: "active" },
        {
          regions: ["Chest"],
        }
      )
    );
    expect(getInjuryConstraints(profile.id)[0].scope).toBe("region");
  });
});

// #2297 — the edit form's half of the round trip: a narrowing correction reaches the
// engine, and the lifecycle the form deliberately does not edit survives it.
//
// #2359 changed WHY the second half holds. `updateInjury` used to write the whole row,
// so the form kept status/since/notes/muscles alive by submitting them back as hidden
// inputs — correct, but only for as long as everyone remembered. The action now sends a
// PARTIAL naming just the declaration and the write core leaves an unnamed column alone,
// so these cases submit nothing beyond what the form actually edits.
describe("correcting a constraint after it is understood (#2297)", () => {
  // The realistic sequence from the issue: logged broadly on day one, narrowed a week
  // later to the movement that is actually affected.
  async function logBroadShoulder(): Promise<{
    profileId: number;
    id: number;
  }> {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        { label: "shoulder", status: "active", since: "2026-07-01" },
        { regions: ["Chest", "Shoulders"] }
      )
    );
    return { profileId: profile.id, id: getInjuries(profile.id)[0].id };
  }

  it("narrowing to the lifts that hurt puts the rest of the region back in play", async () => {
    const { profileId, id } = await logBroadShoulder();
    // Day one: the whole region is off the table, Cable Fly included.
    expect(
      exerciseInjuryVerdict(getInjuryConstraints(profileId), "Cable Fly").kind
    ).toBe("excluded");

    const res = await updateInjury(
      injuryForm(
        { id: String(id), label: "shoulder" },
        { regions: ["Chest", "Shoulders"], exercises: ["Overhead Press"] }
      )
    );
    expect(res.ok).toBe(true);

    const constraints = getInjuryConstraints(profileId);
    expect(constraints[0].scope).toBe("exercise");
    // The named lift is still excluded; the lift that was only ever collateral is clear.
    expect(exerciseInjuryVerdict(constraints, "Overhead Press").kind).toBe(
      "excluded"
    );
    expect(exerciseInjuryVerdict(constraints, "Cable Fly").kind).toBe("clear");
  });

  it("keeps the start date, the status, the notes and the fine muscles it never mentions", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        {
          label: "left knee",
          status: "recovering",
          since: "2026-06-15",
          notes: "tweaked it on a run",
          loadFactor: "0.5",
        },
        { regions: ["Legs"], muscles: ["quads"] }
      )
    );
    const before = getInjuries(profile.id)[0];

    // The form submits ONLY the declaration it edits (#2359) — no status, no since,
    // no notes, no muscles. Before the partial this would have cleared all four.
    await updateInjury(
      injuryForm(
        { id: String(before.id), label: "left knee", loadFactor: "0.5" },
        { regions: ["Legs"], movements: ["legs"] }
      )
    );

    const after = getInjuries(profile.id)[0];
    expect(after.since).toBe("2026-06-15"); // history, not a correction
    expect(after.status).toBe("recovering"); // the chip's buttons own this
    expect(after.notes).toBe("tweaked it on a run"); // no control for it, so not dropped
    expect(after.muscles).toEqual(["quads"]); // likewise
    expect(after.loadFactor).toBe(0.5);
    expect(after.movements).toEqual(["legs"]); // …and the correction landed
  });

  // The trap #2359 removes, pinned as a PROPERTY rather than as a list of the fields
  // that happen to exist today: enumerate the injury row's real columns and require
  // every one of them to survive a patch that does not name it. Add a column, write
  // it from the write core, and forget to carry it through `mergePatch` — this fails,
  // where the old per-field assertions could not, because they could only ever pin
  // the fields their author knew about.
  it("leaves every column a partial update does not name exactly as it was", async () => {
    const { profile } = seedActor();
    await logInjury(
      injuryForm(
        {
          label: "right elbow",
          status: "recovering",
          since: "2026-05-02",
          notes: "sore on pressing",
          laterality: "right",
          loadFactor: "0.7",
          reviewDate: "2026-09-30",
        },
        {
          regions: ["Arms"],
          muscles: ["biceps"],
          movements: ["push"],
          exercises: ["Bench Press"],
        }
      )
    );
    const id = getInjuries(profile.id)[0].id;

    // Every column of the row, read from the migrated schema so a NEW one joins this
    // census automatically instead of waiting to be remembered.
    const columns = (
      db.prepare("PRAGMA table_info(injuries)").all() as { name: string }[]
    ).map((c) => c.name);
    const readRow = () =>
      db.prepare("SELECT * FROM injuries WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
    const before = readRow();

    // Guard the census itself: a column sitting at its default proves nothing about
    // having been preserved, so the fixture above must give every column a value.
    // ONE exemption, with its reason — `resolved_date` is derived from status and can
    // only be non-null on a RESOLVED row, which cannot also carry the recovering-only
    // load preference this fixture needs. It stays in the equality loop below, where
    // "still null" is exactly the assertion that matters for it.
    const NULL_BY_CONSTRUCTION = new Set(["resolved_date"]);
    for (const c of columns) {
      if (NULL_BY_CONSTRUCTION.has(c)) continue;
      expect(
        before[c],
        `fixture leaves injuries.${c} empty — give it a value`
      ).not.toBeNull();
    }

    // Submit exactly what the edit form submits — its own scope controls, unchanged,
    // with only the label corrected. Nothing else is named anywhere in the request.
    const res = await updateInjury(
      injuryForm(
        {
          id: String(id),
          label: "right elbow (tendon)",
          laterality: "right",
          loadFactor: "0.7",
          reviewDate: "2026-09-30",
        },
        {
          regions: ["Arms"],
          movements: ["push"],
          exercises: ["Bench Press"],
        }
      )
    );
    expect(res.ok).toBe(true);

    const after = readRow();
    expect(after.label).toBe("right elbow (tendon)");
    for (const c of columns) {
      if (c === "label") continue;
      expect(
        after[c],
        `injuries.${c} was changed by an edit that never named it`
      ).toEqual(before[c]);
    }
  });

  it("refuses an edit that leaves no affected region, without damaging the row", async () => {
    const { profileId, id } = await logBroadShoulder();
    const res = await updateInjury(
      injuryForm({ id: String(id), label: "shoulder", status: "active" })
    );
    expect(res.ok).toBe(false);
    const [row] = getInjuries(profileId);
    expect(row.regions).toEqual(["Chest", "Shoulders"]);
  });

  it("cannot correct another profile's constraint", async () => {
    const { profile } = seedActor();
    const otherId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Someone Else")
        .lastInsertRowid
    );
    const theirs = Number(
      db
        .prepare(
          `INSERT INTO injuries (profile_id, label, regions, status)
           VALUES (?, 'their shoulder', '["Chest"]', 'active')`
        )
        .run(otherId).lastInsertRowid
    );
    const res = await updateInjury(
      injuryForm(
        { id: String(theirs), label: "mine now", status: "active" },
        { regions: ["Legs"] }
      )
    );
    expect(res.ok).toBe(false);
    const row = db
      .prepare("SELECT label, regions FROM injuries WHERE id = ?")
      .get(theirs) as { label: string; regions: string };
    expect(row).toEqual({ label: "their shoulder", regions: '["Chest"]' });
    expect(getInjuries(profile.id)).toHaveLength(0);
  });
});

describe("profile scoping and migration compatibility", () => {
  it("another profile's injury is invisible and unwritable", async () => {
    const { profile } = seedActor();
    const otherId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Someone Else")
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO injuries (profile_id, label, regions, status)
       VALUES (?, 'their knee', '["Legs"]', 'active')`
    ).run(otherId);

    expect(getInjuries(profile.id)).toHaveLength(0);
    expect(getInjuryConstraints(profile.id)).toHaveLength(0);

    const theirId = Number(
      (
        db
          .prepare("SELECT id FROM injuries WHERE profile_id = ?")
          .get(otherId) as { id: number }
      ).id
    );
    const form = new FormData();
    form.set("id", String(theirId));
    form.set("status", "resolved");
    // The acting profile cannot move a row it does not own.
    expect((await setInjuryStatus(form)).ok).toBe(false);
    expect(
      (
        db.prepare("SELECT status FROM injuries WHERE id = ?").get(theirId) as {
          status: string;
        }
      ).status
    ).toBe("active");
  });

  it("a pre-#2024 row (all new columns NULL) reads back as a region constraint", async () => {
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO injuries (profile_id, label, regions, status)
       VALUES (?, 'legacy shoulder', '["Chest"]', 'active')`
    ).run(profile.id);

    const [row] = getInjuries(profile.id);
    expect(row.laterality).toBeNull();
    expect(row.movements).toEqual([]);
    expect(row.exercises).toEqual([]);
    expect(row.loadFactor).toBeNull();
    expect(row.reviewDate).toBeNull();

    const [c] = getInjuryConstraints(profile.id);
    expect(c.scope).toBe("region");
    // …and behaves exactly as it did before: the whole region is off the table.
    expect(exerciseInjuryVerdict([c], "Bench Press").kind).toBe("excluded");
    expect(exerciseInjuryVerdict([c], "Cable Fly").kind).toBe("excluded");
  });
});
