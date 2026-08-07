// SERVER-ACTION TIER (issues #1934, #1963) — the row-scoped repair paths for the two
// one-tap stores: correct a serving/photo, and (since #1963) REMOVE one named serving.
//
// The cores are auth-blind; the gate lives here. This tier proves the part the DB tier
// structurally cannot see: that `updateFoodLogEvent`, `deleteFoodLogEvent`, and
// `updateProgressPhoto` run through requireWriteAccess, answer with TYPED outcomes rather
// than confirming unconditionally, revalidate the surfaces the changed value is rendered
// on, and refuse a row belonging to ANOTHER profile while writing nothing.

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  deleteFoodLogEvent,
  updateFoodLogEvent,
} from "@/app/(app)/nutrition/actions";
import {
  uploadProgressPhoto,
  updateProgressPhoto,
} from "@/app/(app)/progress/actions";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { getFoodMealDays } from "@/lib/queries";
import { type FoodSlot } from "@/lib/food-slot";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Per-window tallies through the meal grouping the web surface renders
// (getFoodMealDays.slotCounts) — the live consumer of the window derivation, standing
// where the retired slot-count query (getFoodSlotServingsOnDate, #2019/#2227) used to.
function slotServingsOnDate(
  profileId: number,
  window: FoodSlot,
  date: string
): Map<string, number> {
  const [day] = getFoodMealDays(profileId, [date]);
  return new Map(Object.entries(day.slotCounts[window]));
}

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
});

// ---- Food servings ----

function seedServing(profileId: number, date: string, group = "berries") {
  logFoodServingCore(profileId, group, date, `${date}T08:00:00Z`, "Morning");
  const row = db
    .prepare(
      `SELECT id FROM food_log_events WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as { id: number };
  return row.id;
}

function counters(profileId: number) {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? ORDER BY date, group_key`
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
}

describe("updateFoodLogEvent (#1934)", () => {
  it("moves a mis-slotted serving and answers with both placements", async () => {
    const login = createLogin();
    const profile = createProfile(`food-correct ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    const res = await updateFoodLogEvent(
      fd({ event_id: eventId, meal_slot: "Evening" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The bar sets BOTH coordinates from these numbers, which is what makes the
    // correction a move rather than a second serving.
    expect(res.from).toEqual({
      date,
      groupKey: "berries",
      mealSlot: "Morning",
      servings: 1,
      mealServings: 0,
    });
    expect(res.to).toEqual({
      date,
      groupKey: "berries",
      mealSlot: "Evening",
      servings: 1,
      mealServings: 1,
    });

    expect(
      slotServingsOnDate(profile.id, "Morning", date).get("berries")
    ).toBeUndefined();
    expect(slotServingsOnDate(profile.id, "Evening", date).get("berries")).toBe(
      1
    );
    // The corrected value is rendered on the Food tab, the trends rollup, and the
    // dashboard, so all three are revalidated.
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
    expect(revalidate).toHaveBeenCalledWith("/trends");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("moves the day counter when the group changes", async () => {
    const login = createLogin();
    const profile = createProfile(`food-regroup ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    const res = await updateFoodLogEvent(
      fd({ event_id: eventId, group_key: "fruit", meal_slot: "Morning" })
    );
    expect(res.ok).toBe(true);
    expect(counters(profile.id)).toEqual([
      { date, group_key: "fruit", servings: 1 },
    ]);
    const [day] = getFoodMealDays(profile.id, [date]);
    expect(day.counts.berries).toBeUndefined();
    expect(day.counts.fruit).toBe(1);
  });

  it("refuses without write access and leaves the serving where it was", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`food-readonly ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    actAs(login, profile, "read");
    await expect(
      updateFoodLogEvent(fd({ event_id: eventId, meal_slot: "Evening" }))
    ).rejects.toThrow();

    expect(slotServingsOnDate(profile.id, "Morning", date).get("berries")).toBe(
      1
    );
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses another profile's serving without touching it", async () => {
    const ownerLogin = createLogin();
    const owner = createProfile(`food-owner ${ownerLogin.id}`, ownerLogin.id);
    actAs(ownerLogin, owner);
    const date = today(owner.id);
    const eventId = seedServing(owner.id, date);

    const intruderLogin = createLogin();
    const intruder = createProfile(
      `food-intruder ${intruderLogin.id}`,
      intruderLogin.id
    );
    actAs(intruderLogin, intruder);

    const res = await updateFoodLogEvent(
      fd({ event_id: eventId, group_key: "fruit", meal_slot: "Evening" })
    );
    expect(res).toEqual({
      ok: false,
      error: "That serving is no longer available.",
    });
    // The victim's ledger row and counter are exactly as they were.
    expect(counters(owner.id)).toEqual([
      { date, group_key: "berries", servings: 1 },
    ]);
    expect(slotServingsOnDate(owner.id, "Morning", date).get("berries")).toBe(
      1
    );
    expect(counters(intruder.id)).toEqual([]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("answers typed errors for a bad group, date, or id", async () => {
    const login = createLogin();
    const profile = createProfile(`food-bad ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    expect(
      await updateFoodLogEvent(fd({ event_id: eventId, group_key: "nope" }))
    ).toEqual({ ok: false, error: "Unknown food group." });
    expect(
      await updateFoodLogEvent(fd({ event_id: eventId, date: "07/08/2026" }))
    ).toEqual({ ok: false, error: "Enter a valid date." });
    expect(
      await updateFoodLogEvent(fd({ event_id: eventId, meal_slot: "Brunch" }))
    ).toEqual({ ok: false, error: "Unknown meal." });
    expect(await updateFoodLogEvent(fd({ event_id: 0 }))).toEqual({
      ok: false,
      error: "That serving is no longer available.",
    });
    expect(counters(profile.id)).toEqual([
      { date, group_key: "berries", servings: 1 },
    ]);
    expect(revalidate).not.toHaveBeenCalled();
  });
});

// ---- Row-scoped serving removal (issue #1963) ----

describe("deleteFoodLogEvent (#1963)", () => {
  it("removes the named serving and answers with the vacated placement", async () => {
    const login = createLogin();
    const profile = createProfile(`food-remove ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    const res = await deleteFoodLogEvent(fd({ event_id: eventId }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The bar SETS the coordinate from these numbers rather than decrementing locally.
    expect(res.vacated).toEqual({
      date,
      groupKey: "berries",
      mealSlot: "Morning",
      servings: 0,
      mealServings: 0,
    });

    expect(counters(profile.id)).toEqual([]);
    expect(
      slotServingsOnDate(profile.id, "Morning", date).get("berries")
    ).toBeUndefined();
    const [day] = getFoodMealDays(profile.id, [date]);
    expect(day.events).toHaveLength(0);
    // The removal is rendered on the Food tab, the trends rollup, and the dashboard.
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
    expect(revalidate).toHaveBeenCalledWith("/trends");
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("refuses without write access and leaves the serving alone", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`food-remove-readonly ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    const eventId = seedServing(profile.id, date);

    actAs(login, profile, "read");
    await expect(
      deleteFoodLogEvent(fd({ event_id: eventId }))
    ).rejects.toThrow();

    expect(counters(profile.id)).toEqual([
      { date, group_key: "berries", servings: 1 },
    ]);
    expect(slotServingsOnDate(profile.id, "Morning", date).get("berries")).toBe(
      1
    );
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses another profile's serving without touching it", async () => {
    const ownerLogin = createLogin();
    const owner = createProfile(
      `food-remove-owner ${ownerLogin.id}`,
      ownerLogin.id
    );
    actAs(ownerLogin, owner);
    const date = today(owner.id);
    const eventId = seedServing(owner.id, date);

    const intruderLogin = createLogin();
    const intruder = createProfile(
      `food-remove-intruder ${intruderLogin.id}`,
      intruderLogin.id
    );
    actAs(intruderLogin, intruder);
    revalidate.mockClear();

    expect(await deleteFoodLogEvent(fd({ event_id: eventId }))).toEqual({
      ok: false,
      error: "That serving is no longer available.",
    });
    expect(counters(owner.id)).toEqual([
      { date, group_key: "berries", servings: 1 },
    ]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("answers typed errors for a bad id and for the protein ranking row", async () => {
    const login = createLogin();
    const profile = createProfile(`food-remove-bad ${login.id}`, login.id);
    actAs(login, profile);
    const date = today(profile.id);
    seedServing(profile.id, date);

    expect(await deleteFoodLogEvent(fd({ event_id: 0 }))).toEqual({
      ok: false,
      error: "That serving is no longer available.",
    });
    expect(await deleteFoodLogEvent(fd({ event_id: 9_999_999 }))).toEqual({
      ok: false,
      error: "That serving is no longer available.",
    });

    // `__protein__` never renders as a serving row (getFoodMealDays skips it), so this id
    // can only arrive forged or stale — and its truth is the protein grams total.
    addProteinGramsCore(profile.id, date, 25, `${date}T18:00:00Z`);
    const proteinId = (
      db
        .prepare(
          `SELECT id FROM food_log_events
            WHERE profile_id = ? AND group_key = ? ORDER BY id DESC LIMIT 1`
        )
        .get(profile.id, PROTEIN_NUDGE_KEY) as { id: number }
    ).id;
    expect(await deleteFoodLogEvent(fd({ event_id: proteinId }))).toEqual({
      ok: false,
      error: "Protein logs are removed from the protein total.",
    });

    expect(counters(profile.id)).toEqual([
      { date, group_key: "berries", servings: 1 },
    ]);
    expect(revalidate).not.toHaveBeenCalled();
  });
});

// ---- Progress photos ----

async function uniqueJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: seed % 251, g: (seed * 7) % 251, b: (seed * 13) % 251 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function seedPhoto(
  seed: number,
  fields: Record<string, string>
): Promise<number> {
  const form = new FormData();
  const bytes = await uniqueJpeg(seed);
  form.set(
    "photo",
    new File([new Uint8Array(bytes)], "capture.jpg", { type: "image/jpeg" })
  );
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await uploadProgressPhoto(form);
  expect(res.ok).toBe(true);
  const row = db
    .prepare(`SELECT id FROM progress_photos ORDER BY id DESC LIMIT 1`)
    .get() as { id: number };
  return row.id;
}

function photoRow(id: number) {
  return db
    .prepare(
      `SELECT profile_id, date, pose, caption, stored_path, thumb_path, content_hash
         FROM progress_photos WHERE id = ?`
    )
    .get(id) as {
    profile_id: number;
    date: string;
    pose: string;
    caption: string | null;
    stored_path: string;
    thumb_path: string;
    content_hash: string;
  };
}

describe("updateProgressPhoto (#1934)", () => {
  it("retags pose/date/caption and leaves the stored artifacts alone", async () => {
    const login = createLogin();
    const profile = createProfile(`photo-correct ${login.id}`, login.id);
    actAs(login, profile);
    const id = await seedPhoto(11, {
      pose: "front",
      date: "2026-05-01",
      caption: "wrong",
    });
    const before = photoRow(id);
    const onDisk = path.resolve(process.cwd(), before.stored_path);
    const bytesBefore = fs.readFileSync(onDisk);
    revalidate.mockClear();

    const res = await updateProgressPhoto(
      fd({ photo_id: id, pose: "side", date: "2026-04-20", caption: "left" })
    );
    expect(res).toEqual({ ok: true });

    const after = photoRow(id);
    expect(after).toMatchObject({
      date: "2026-04-20",
      pose: "side",
      caption: "left",
    });
    // The action never reaches processPhoto or the file store — the artifacts are
    // identical and the bytes on disk are untouched.
    expect(after.stored_path).toBe(before.stored_path);
    expect(after.thumb_path).toBe(before.thumb_path);
    expect(after.content_hash).toBe(before.content_hash);
    expect(fs.readFileSync(onDisk).equals(bytesBefore)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/progress");

    fs.rmSync(path.dirname(onDisk), { recursive: true, force: true });
  });

  it("refuses an off-vocabulary pose with a typed error", async () => {
    const login = createLogin();
    const profile = createProfile(`photo-pose ${login.id}`, login.id);
    actAs(login, profile);
    const id = await seedPhoto(12, { pose: "back", date: "2026-05-02" });
    revalidate.mockClear();

    const res = await updateProgressPhoto(
      fd({ photo_id: id, pose: "flex", date: "2026-05-02", caption: "" })
    );
    expect(res.ok).toBe(false);
    expect(photoRow(id).pose).toBe("back");
    expect(revalidate).not.toHaveBeenCalled();

    fs.rmSync(
      path.dirname(path.resolve(process.cwd(), photoRow(id).stored_path)),
      { recursive: true, force: true }
    );
  });

  it("refuses without write access", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile(`photo-readonly ${login.id}`, login.id);
    actAs(login, profile);
    const id = await seedPhoto(13, { pose: "front", date: "2026-05-03" });

    actAs(login, profile, "read");
    await expect(
      updateProgressPhoto(
        fd({ photo_id: id, pose: "back", date: "2026-05-03", caption: "" })
      )
    ).rejects.toThrow();
    expect(photoRow(id).pose).toBe("front");

    fs.rmSync(
      path.dirname(path.resolve(process.cwd(), photoRow(id).stored_path)),
      { recursive: true, force: true }
    );
  });

  it("refuses another profile's photo without touching it", async () => {
    const ownerLogin = createLogin();
    const owner = createProfile(`photo-owner ${ownerLogin.id}`, ownerLogin.id);
    actAs(ownerLogin, owner);
    const id = await seedPhoto(14, {
      pose: "front",
      date: "2026-05-04",
      caption: "mine",
    });
    const before = photoRow(id);

    const intruderLogin = createLogin();
    const intruder = createProfile(
      `photo-intruder ${intruderLogin.id}`,
      intruderLogin.id
    );
    actAs(intruderLogin, intruder);
    revalidate.mockClear();

    const res = await updateProgressPhoto(
      fd({ photo_id: id, pose: "back", date: "2026-01-01", caption: "stolen" })
    );
    expect(res).toEqual({
      ok: false,
      error: "That photo is no longer available.",
    });
    expect(photoRow(id)).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();

    fs.rmSync(path.dirname(path.resolve(process.cwd(), before.stored_path)), {
      recursive: true,
      force: true,
    });
  });
});
