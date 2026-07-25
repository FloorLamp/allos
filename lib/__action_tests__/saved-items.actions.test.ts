// SERVER-ACTION TIER — the unified save gesture (issue #1456).
//
// Drives the real Server Actions (app/(app)/saved/actions.ts) against the throwaway
// temp DB: the ★ toggle that writes `saved_items`, its #482 family semantics on the
// write path, the kind dispatch, the key-parse rejection, the reorder, and the auth
// gate (a READ-ONLY actor cannot save). The pure tier can't see any of that, and the
// DB tier drives the lib cores rather than the action.
//
// All values are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { toggleSavedItem, moveSaved } from "@/app/(app)/saved/actions";
import { seedActor, createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function saved(profileId: number): { kind: string; key: string }[] {
  return db
    .prepare(
      `SELECT kind, key FROM saved_items WHERE profile_id = ?
        ORDER BY (position IS NULL), position, created_at DESC, id DESC`
    )
    .all(profileId) as { kind: string; key: string }[];
}

describe("toggleSavedItem", () => {
  it("stars a biomarker from its series key and revalidates every save surface", async () => {
    const { profile } = seedActor();

    const res = await toggleSavedItem(fd({ key: "bio:ApoB" }));

    expect(res.ok).toBe(true);
    expect(saved(profile.id)).toEqual([{ kind: "biomarker", key: "ApoB" }]);
    // A save is membership on three surfaces at once — that IS the issue.
    const paths = revalidate.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/trends");
    expect(paths).toContain("/results");
    expect(paths).toContain("/biomarkers/view");
  });

  it("un-stars on a second submit (the same gesture both ways)", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    expect(saved(profile.id)).toEqual([]);
  });

  it("un-stars through the #482 FAMILY, so the toggle can't stick", async () => {
    // Star one spelling of the 25-OH total, then submit a SIBLING spelling: the
    // family already reads as saved, so this must CLEAR it rather than add a row.
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:Vitamin D, Total" }));
    expect(saved(profile.id).length).toBe(1);

    await toggleSavedItem(fd({ key: "bio:25-OH Vitamin D" }));

    expect(saved(profile.id)).toEqual([]);
  });

  it("saves a trend-metric under its own kind, keyed by the bare metric id", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "metric:weight" }));
    expect(saved(profile.id)).toEqual([
      { kind: "trend-metric", key: "weight" },
    ]);
  });

  it("keeps a biomarker and a metric of the same name apart", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "metric:weight" }));
    await toggleSavedItem(fd({ key: "bio:weight" }));
    // Two rows, same key, different kinds — `kind` is what keeps them apart.
    expect(new Set(saved(profile.id).map((r) => `${r.kind}:${r.key}`))).toEqual(
      new Set(["trend-metric:weight", "biomarker:weight"])
    );
  });

  it("refuses an unparseable key instead of writing a junk row", async () => {
    const { profile } = seedActor();
    for (const key of ["", "ApoB", "provider:12", "bio:"]) {
      const res = await toggleSavedItem(fd({ key }));
      expect(res.ok).toBe(false);
    }
    expect(saved(profile.id)).toEqual([]);
  });

  it("writes only to the ACTING profile", async () => {
    const login = createLogin({ role: "admin" });
    const mine = createProfile("Mine", login.id);
    const other = createProfile("Other", login.id);
    actAs(login, mine);

    await toggleSavedItem(fd({ key: "bio:ApoB" }));

    expect(saved(mine.id)).toEqual([{ kind: "biomarker", key: "ApoB" }]);
    expect(saved(other.id)).toEqual([]);
  });

  it("refuses a read-only actor (the auth gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Read Only", login.id);
    actAs(login, profile, "read");

    await expect(toggleSavedItem(fd({ key: "bio:ApoB" }))).rejects.toThrow();
    expect(saved(profile.id)).toEqual([]);
  });
});

describe("moveSaved", () => {
  it("reorders within the saved list and revalidates /trends", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "metric:weight" }));
    const before = saved(profile.id).map((r) => r.key);
    revalidate.mockClear();

    const res = await moveSaved(fd({ key: "bio:ApoB", dir: "up" }));

    expect(res.ok).toBe(true);
    expect(saved(profile.id).map((r) => r.key)).toEqual([before[1], before[0]]);
    expect(revalidate.mock.calls.map((c) => c[0])).toContain("/trends");
  });

  it("never changes WHAT is saved — only the order", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "metric:weight" }));

    await moveSaved(fd({ key: "metric:weight", dir: "down" }));
    await moveSaved(fd({ key: "metric:weight", dir: "down" })); // at the end: no-op

    expect(new Set(saved(profile.id).map((r) => `${r.kind}:${r.key}`))).toEqual(
      new Set(["biomarker:ApoB", "trend-metric:weight"])
    );
  });

  it("refuses an unparseable key and no-ops for an unsaved item", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));

    expect((await moveSaved(fd({ key: "nonsense", dir: "up" }))).ok).toBe(
      false
    );
    // Parseable but not saved — a valid request that simply matches nothing.
    expect((await moveSaved(fd({ key: "bio:Ferritin", dir: "up" }))).ok).toBe(
      true
    );
    expect(saved(profile.id)).toEqual([{ kind: "biomarker", key: "ApoB" }]);
  });

  it("refuses a read-only actor (the auth gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Read Only Move", login.id);
    actAs(login, profile, "write");
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    actAs(login, profile, "read");

    await expect(
      moveSaved(fd({ key: "bio:ApoB", dir: "up" }))
    ).rejects.toThrow();
  });
});
