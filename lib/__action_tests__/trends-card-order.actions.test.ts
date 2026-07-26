// SERVER-ACTION TIER — the #1490 override: a user's per-tab Trends card
// arrangement.
//
// The ranked default only serves a profile that has never arranged a tab; once an
// arrangement is stored it wins permanently. The drag affordance that WRITES it is
// #1485-C's reorder extension, so this tier is what proves the write path, its auth
// gate, and the read-side merge — the pure tier can't see any of the three.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  resetTrendsCardOrder,
  saveTrendsCardOrder,
} from "@/app/(app)/trends/actions";
import { getProfileSetting, getTrendsCardOrder } from "@/lib/settings";
import { bodyCardOrder, rankBodyCards } from "@/lib/trends-card-rank";
import { buildTrendsSubjectContext } from "@/lib/queries";
import { today } from "@/lib/db";
import { seedActor, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("saveTrendsCardOrder", () => {
  it("persists the tab's arrangement under the acting profile and revalidates", async () => {
    const { profile } = seedActor();

    const res = await saveTrendsCardOrder(
      form({ tab: "body", ids: "mood,steps,weight" })
    );

    expect(res.ok).toBe(true);
    expect(getTrendsCardOrder(profile.id, "body")).toEqual([
      "mood",
      "steps",
      "weight",
    ]);
    // One key holds every tab, so a new tab needs no new settings key.
    const raw = getProfileSetting(profile.id, "trends_card_order");
    expect(raw && JSON.parse(raw)).toEqual({
      body: ["mood", "steps", "weight"],
    });
    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("trims and de-duplicates the submitted ids", async () => {
    const { profile } = seedActor();
    await saveTrendsCardOrder(
      form({ tab: "body", ids: " mood , mood ,,steps " })
    );
    expect(getTrendsCardOrder(profile.id, "body")).toEqual(["mood", "steps"]);
  });

  it("refuses an empty arrangement rather than storing a hole", async () => {
    const { profile } = seedActor();
    const res = await saveTrendsCardOrder(form({ tab: "body", ids: " , " }));
    expect(res.ok).toBe(false);
    expect(getTrendsCardOrder(profile.id, "body")).toBeNull();
  });

  it("keeps each tab's arrangement independent", async () => {
    const { profile } = seedActor();
    await saveTrendsCardOrder(form({ tab: "body", ids: "mood,steps" }));
    await saveTrendsCardOrder(form({ tab: "nutrition", ids: "macros" }));
    expect(getTrendsCardOrder(profile.id, "body")).toEqual(["mood", "steps"]);
    expect(getTrendsCardOrder(profile.id, "nutrition")).toEqual(["macros"]);
  });

  it("normalizes an unknown tab name onto a real tab (the shared parser)", async () => {
    const { profile } = seedActor();
    // `?tab=vitals` is the retired vocabulary that maps onto Body (#1486); an
    // outright bogus value falls back to the default tab rather than minting a key.
    await saveTrendsCardOrder(form({ tab: "vitals", ids: "mood" }));
    expect(getTrendsCardOrder(profile.id, "body")).toEqual(["mood"]);
    await saveTrendsCardOrder(form({ tab: "nonsense", ids: "weight" }));
    expect(getTrendsCardOrder(profile.id, "overview")).toEqual(["weight"]);
  });

  it("writes to the ACTING profile only", async () => {
    const { login, profile } = seedActor();
    const other = createProfile("Other subject", login.id);
    await saveTrendsCardOrder(form({ tab: "body", ids: "mood" }));
    expect(getTrendsCardOrder(other.id, "body")).toBeNull();

    actAs(login, other);
    await saveTrendsCardOrder(form({ tab: "body", ids: "steps" }));
    expect(getTrendsCardOrder(other.id, "body")).toEqual(["steps"]);
    // …and the first profile's arrangement is untouched.
    expect(getTrendsCardOrder(profile.id, "body")).toEqual(["mood"]);
  });
});

describe("resetTrendsCardOrder", () => {
  it("forgets the arrangement so the ranked default serves again", async () => {
    const { profile } = seedActor();
    await saveTrendsCardOrder(form({ tab: "body", ids: "mood,steps" }));
    const res = await resetTrendsCardOrder(form({ tab: "body" }));
    expect(res.ok).toBe(true);
    expect(getTrendsCardOrder(profile.id, "body")).toBeNull();
  });
});

describe("the stored arrangement beats the ranker end to end", () => {
  it("wins on the next read, with unseen cards appended at their ranked position", async () => {
    const { profile } = seedActor();
    const anchor = today(profile.id);
    const ctx = buildTrendsSubjectContext(profile.id, anchor);

    // Never arranged: the ranked default is the whole answer.
    expect(bodyCardOrder(ctx, getTrendsCardOrder(profile.id, "body"))).toEqual(
      rankBodyCards(ctx)
    );

    await saveTrendsCardOrder(form({ tab: "body", ids: "mood,steps" }));

    const order = bodyCardOrder(ctx, getTrendsCardOrder(profile.id, "body"));
    expect(order.slice(0, 2)).toEqual(["mood", "steps"]);
    // Everything the arrangement never saw follows in ranked order — appended, not
    // reshuffled into the user's two.
    expect(order.slice(2)).toEqual(
      rankBodyCards(ctx).filter((id) => id !== "mood" && id !== "steps")
    );
  });
});
