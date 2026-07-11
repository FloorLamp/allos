// SERVER-ACTION TIER — issue #333: every activity write must revalidate /trends
// (the FitnessSection volume chart + WorkoutHeatmapSection), not just /training and
// the dashboard. /trends reads activity-derived data, so a create/edit/merge/delete
// that skips it leaves the fitness chart and heatmap stale. These tests pin the exact
// revalidated path SET for each mutation so a future edit can't silently drop /trends
// again.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  saveActivity,
  logBodyweight,
  mergeActivities,
  deleteActivity,
} from "@/app/(app)/journal/actions";
import { mergeActivityPair } from "@/app/(app)/data/review-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// The set of distinct paths an action asked Next to revalidate.
const revalidatedPaths = () =>
  new Set(revalidate.mock.calls.map((c) => c[0] as string));

function insertActivity(
  profileId: number,
  over: Partial<{ date: string; title: string }> = {}
): number {
  const row = { date: "2026-05-01", title: "Run", ...over };
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, edited)
         VALUES (?, ?, 'cardio', ?, 0)`
      )
      .run(profileId, row.date, row.title).lastInsertRowid
  );
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("activity writes revalidate /trends (#333)", () => {
  it("saveActivity (create) refreshes /training, /trends, and /", async () => {
    const login = createLogin();
    const profile = createProfile("save-create", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({ type: "cardio", title: "Evening run", date: "2026-05-02" })
    );

    expect(res).toEqual({ id: expect.any(Number) });
    expect(revalidatedPaths()).toEqual(new Set(["/training", "/trends", "/"]));
  });

  it("saveActivity (edit) refreshes /training, /trends, and /", async () => {
    const login = createLogin();
    const profile = createProfile("save-edit", login.id);
    actAs(login, profile);
    const id = insertActivity(profile.id, { title: "Before" });

    await saveActivity(
      fd({ id, type: "cardio", title: "After", date: "2026-05-01" })
    );

    expect(revalidatedPaths()).toEqual(new Set(["/training", "/trends", "/"]));
  });

  it("logBodyweight refreshes /training, /trends, and / (bodyweight-lift volume)", async () => {
    const login = createLogin();
    const profile = createProfile("bw", login.id);
    actAs(login, profile);

    await logBodyweight(80, "2026-05-01");

    expect(revalidatedPaths()).toEqual(new Set(["/training", "/trends", "/"]));
  });

  it("mergeActivities refreshes /training, /trends, and /", async () => {
    const login = createLogin();
    const profile = createProfile("merge", login.id);
    actAs(login, profile);
    const keepId = insertActivity(profile.id, { title: "Keeper" });
    const dropId = insertActivity(profile.id, { title: "Drop" });

    const { undoId } = await mergeActivities(
      fd({ keep_id: keepId, drop_id: dropId })
    );

    expect(undoId).not.toBeNull();
    expect(revalidatedPaths()).toEqual(new Set(["/training", "/trends", "/"]));
  });

  it("deleteActivity refreshes /training, /trends, and /", async () => {
    const login = createLogin();
    const profile = createProfile("delete", login.id);
    actAs(login, profile);
    const id = insertActivity(profile.id, { title: "Doomed" });

    const { undoId } = await deleteActivity(fd({ id }));

    expect(undoId).not.toBeNull();
    expect(revalidatedPaths()).toEqual(new Set(["/training", "/trends", "/"]));
  });

  it("mergeActivityPair (Review resolver) refreshes /data, /training, /trends, and /", async () => {
    const login = createLogin();
    const profile = createProfile("review-merge", login.id);
    actAs(login, profile);
    const keepId = insertActivity(profile.id, { title: "Keeper" });
    const dropId = insertActivity(profile.id, { title: "Drop" });

    await mergeActivityPair(
      fd({ keep_id: keepId, drop_id: dropId, signature: "id:1|id:2" })
    );

    expect(revalidatedPaths()).toEqual(
      new Set(["/data", "/training", "/trends", "/"])
    );
  });
});
