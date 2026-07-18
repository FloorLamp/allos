// SERVER-ACTION TIER — protein-grams quick-add write path (issue #824).
//
// Proves the real addProteinGrams/undoProteinGrams actions run through the (mocked) auth
// guard, keep ONE row per (profile, date) whose grams SUM on repeated adds, decrement +
// drop the row at zero on undo, reject a non-positive/over-cap amount, record the
// last-used preset, revalidate, and scope every write to the acting profile.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addProteinGrams,
  undoProteinGrams,
} from "@/app/(app)/nutrition/actions";
import { getProteinLoggedGrams, getProteinQuickAddPreset } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-07-08";

function rows(profileId: number) {
  return db
    .prepare(
      "SELECT date, grams FROM protein_log WHERE profile_id = ? ORDER BY date"
    )
    .all(profileId) as { date: string; grams: number }[];
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("addProteinGrams", () => {
  it("sums grams into a single (profile, date) row on repeated adds", async () => {
    const login = createLogin();
    const profile = createProfile("protein-logger", login.id);
    actAs(login, profile);

    const first = await addProteinGrams(fd({ grams: "30", date: DATE }));
    expect(first).toEqual({ ok: true, grams: 30 });
    const second = await addProteinGrams(fd({ grams: "25", date: DATE }));
    expect(second).toEqual({ ok: true, grams: 55 });

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ date: DATE, grams: 55 });
    expect(getProteinLoggedGrams(profile.id, DATE)).toBe(55);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("records the last-used amount as the profile's preset (scoop sizes repeat)", async () => {
    const login = createLogin();
    const profile = createProfile("preset-keeper", login.id);
    actAs(login, profile);

    await addProteinGrams(fd({ grams: "30", date: DATE }));
    expect(getProteinQuickAddPreset(profile.id)).toBe(30);
    // A later add moves the preset to the newest amount.
    await addProteinGrams(fd({ grams: "24", date: DATE }));
    expect(getProteinQuickAddPreset(profile.id)).toBe(24);
  });

  it("rejects a non-positive or over-cap amount without writing", async () => {
    const login = createLogin();
    const profile = createProfile("bad-grams", login.id);
    actAs(login, profile);

    expect((await addProteinGrams(fd({ grams: "0", date: DATE }))).ok).toBe(
      false
    );
    expect((await addProteinGrams(fd({ grams: "-5", date: DATE }))).ok).toBe(
      false
    );
    expect((await addProteinGrams(fd({ grams: "9000", date: DATE }))).ok).toBe(
      false
    );
    expect(rows(profile.id)).toEqual([]);
  });
});

describe("undoProteinGrams", () => {
  it("decrements, clamps at zero, and drops the row at zero", async () => {
    const login = createLogin();
    const profile = createProfile("protein-undoer", login.id);
    actAs(login, profile);

    await addProteinGrams(fd({ grams: "30", date: DATE }));
    await addProteinGrams(fd({ grams: "30", date: DATE })); // 60

    const afterUndo = await undoProteinGrams(fd({ grams: "30", date: DATE }));
    expect(afterUndo).toEqual({ ok: true, grams: 30 });
    expect(rows(profile.id)[0].grams).toBe(30);

    // Undo more than remains → clamps to zero and drops the row (never negative).
    const atZero = await undoProteinGrams(fd({ grams: "50", date: DATE }));
    expect(atZero).toEqual({ ok: true, grams: 0 });
    expect(rows(profile.id)).toEqual([]);
  });

  it("undoing a day with nothing logged is a no-op reporting 0", async () => {
    const login = createLogin();
    const profile = createProfile("protein-noop", login.id);
    actAs(login, profile);

    const res = await undoProteinGrams(fd({ grams: "30", date: DATE }));
    expect(res).toEqual({ ok: true, grams: 0 });
    expect(rows(profile.id)).toEqual([]);
  });
});

describe("scoping", () => {
  it("one profile's protein log never leaks into another's total", async () => {
    const login = createLogin();
    const a = createProfile("protein-a", login.id);
    const b = createProfile("protein-b", login.id);

    actAs(login, a);
    await addProteinGrams(fd({ grams: "40", date: DATE }));

    expect(getProteinLoggedGrams(a.id, DATE)).toBe(40);
    expect(getProteinLoggedGrams(b.id, DATE)).toBe(0);
    expect(rows(b.id)).toEqual([]);
  });
});
