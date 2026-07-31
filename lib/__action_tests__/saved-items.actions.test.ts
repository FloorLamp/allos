// SERVER-ACTION TIER — the unified save gesture (issue #1456).
//
// Drives the real Server Actions (app/(app)/saved-actions.ts) against the throwaway
// temp DB: the ★ toggle that writes `saved_items`, its #482 family semantics on the
// write path, the kind dispatch, the key-parse rejection, the reorder, and the auth
// gate (a READ-ONLY actor cannot save). The pure tier can't see any of that, and the
// DB tier drives the lib cores rather than the action.
//
// All values are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { toggleSavedItem, reorderSaved } from "@/app/(app)/saved-actions";
import { seedStandardMetricSaves } from "@/lib/standard-metric-seeds";
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
    expect(paths).toContain("/trends/metric/[kind]");
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

  it("removes a SEEDED standard metric and puts it back on a re-star (#1487)", async () => {
    // Since #1487 a `trend-metric` save is MEMBERSHIP, not promotion: Trends Overview
    // renders the saved set and nothing else, so this toggle is what adds and removes
    // a standard tile. The round trip is the contract — a removal with no way back
    // would strand the tile, which is why SaveTrendPicker offers metrics too.
    const { profile } = seedActor();
    seedStandardMetricSaves(db, profile.id); // what profile creation does

    await toggleSavedItem(fd({ key: "metric:volume" }));
    expect(saved(profile.id).map((r) => `${r.kind}:${r.key}`)).toEqual([
      "trend-metric:weight",
      "trend-metric:bodyfat",
      "trend-metric:resting_hr",
    ]);

    await toggleSavedItem(fd({ key: "metric:volume" }));
    // Back — as a fresh save, so it leads the grid like any other new star.
    expect(saved(profile.id).map((r) => `${r.kind}:${r.key}`)[0]).toBe(
      "trend-metric:volume"
    );
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

// The drag-reorder write (#1485 C). Same store and the same dense-position
// normalization moveSaved uses — the difference is that a drag names a
// DESTINATION, so the whole list arrives at once.
describe("reorderSaved", () => {
  const order = (keys: string[]) => fd({ keys: JSON.stringify(keys) });

  it("sets the saved order outright and revalidates /trends", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "metric:weight" }));
    await toggleSavedItem(fd({ key: "bio:Ferritin" }));
    revalidate.mockClear();

    const res = await reorderSaved(
      order(["metric:weight", "bio:Ferritin", "bio:ApoB"])
    );

    expect(res.ok).toBe(true);
    expect(saved(profile.id).map((r) => r.key)).toEqual([
      "weight",
      "Ferritin",
      "ApoB",
    ]);
    expect(revalidate.mock.calls.map((c) => c[0])).toContain("/trends");
  });

  it("never changes WHAT is saved — a row the client didn't name survives", async () => {
    // The stale-client case: another device starred something since this grid
    // rendered. Omitting it must not delete it.
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "metric:weight" }));

    await reorderSaved(order(["metric:weight"]));

    expect(new Set(saved(profile.id).map((r) => `${r.kind}:${r.key}`))).toEqual(
      new Set(["biomarker:ApoB", "trend-metric:weight"])
    );
    // The named row leads; the unnamed one keeps its place behind it.
    expect(saved(profile.id)[0].key).toBe("weight");
  });

  it("serves the ⋯ menu's arrow fallback too — ONE write, one list", async () => {
    // The convergence #1485 C is about: the arrows no longer step through the
    // stored order in a write of their own. The grid computes the stepped list
    // (moveInOrder, pure) and submits it HERE, exactly as a drag does.
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    await toggleSavedItem(fd({ key: "metric:weight" }));
    await toggleSavedItem(fd({ key: "bio:Ferritin" }));

    await reorderSaved(order(["bio:ApoB", "bio:Ferritin", "metric:weight"]));
    // "Move earlier" on the last tile, as the grid sends it.
    await reorderSaved(order(["bio:ApoB", "metric:weight", "bio:Ferritin"]));

    expect(saved(profile.id).map((r) => r.key)).toEqual([
      "ApoB",
      "weight",
      "Ferritin",
    ]);
  });

  it("refuses unreadable input and drops keys that name nothing savable", async () => {
    const { profile } = seedActor();
    await toggleSavedItem(fd({ key: "bio:ApoB" }));

    expect((await reorderSaved(fd({ keys: "not json" }))).ok).toBe(false);
    expect((await reorderSaved(fd({ keys: JSON.stringify({}) }))).ok).toBe(
      false
    );
    // Every entry unparseable → nothing to order, so it reports rather than
    // silently writing a positions sweep off an empty list.
    expect((await reorderSaved(order(["nonsense", "also:nonsense"]))).ok).toBe(
      false
    );
    expect(saved(profile.id)).toEqual([{ kind: "biomarker", key: "ApoB" }]);
  });

  it("refuses a read-only actor (the auth gate)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Read Only Drag", login.id);
    actAs(login, profile, "write");
    await toggleSavedItem(fd({ key: "bio:ApoB" }));
    actAs(login, profile, "read");

    await expect(reorderSaved(order(["bio:ApoB"]))).rejects.toThrow();
  });
});
