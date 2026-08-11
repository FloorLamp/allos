// DB INTEGRATION TIER (issue #1980): ONE food-group ranking, both surfaces.
//
// Two functions used to exist — `getFoodGroupLogOrder` (web bar) and
// `getFoodNudgeRankedKeys` (Telegram) — whose shared doc comment claimed they "rank
// identically (#221)" while one applied a capped-group demotion and carried the protein
// pseudo-group and the other did neither. `rankFoodGroups` is now the only ranking, and
// `getFoodBarOrder` is a pure resolver over it, so the claim is true by construction.
// These are the pins that keep it true:
//
//   • the web bar's resolved order IS the ranked key list with `__protein__` lifted out
//     at the position it ranked in (not dropped by a `foodGroupBySlug` filter, the #1980
//     defect);
//   • a heavily-logged CAPPED group leads on frecency alone (the reversal of #1822 item 5
//     — the ranking does not editorialize by position);
//   • an EXCLUDED group is still the only demotion, and still reachable at the tail;
//   • a profile that doesn't track protein has no `__protein__` key on EITHER surface.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getFoodBarOrder, rankFoodGroups } from "@/lib/queries";
import { FOOD_QUICK_COUNT } from "@/lib/food-rank";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";
import { setProfileSetting } from "@/lib/settings";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { foodGroupSlugs } from "@/lib/food-groups";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function logServing(
  profileId: number,
  group: string,
  date: string,
  servings = 1
) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, group, servings);
}

describe("rankFoodGroups is the ONE ranking (#1980)", () => {
  it("the web bar's order is the ranked keys, protein lifted out at its rank", () => {
    const { profileId, anchor } = makeProfile("rank-unified-web");
    for (let i = 0; i < 6; i++) {
      logServing(profileId, "berries", shiftDateStr(anchor, -i));
    }
    // Make the profile a protein tracker so __protein__ joins the curated list.
    addProteinGramsCore(profileId, anchor, 30);

    const keys = rankFoodGroups(profileId, "Morning");
    const { groups, proteinRank } = getFoodBarOrder(profileId, "Morning");

    expect(keys).toContain(PROTEIN_NUDGE_KEY);
    expect(proteinRank).toBe(keys.indexOf(PROTEIN_NUDGE_KEY));
    // The resolved rows are the ranked keys with the pseudo-entry removed — same order,
    // nothing dropped, nothing appended by the defensive backfill.
    expect(groups.map((g) => g.slug)).toEqual(
      keys.filter((k) => k !== PROTEIN_NUDGE_KEY)
    );
    expect(groups.length).toBe(foodGroupSlugs().length);
  });

  it("a heavily-logged CAPPED group leads both surfaces (#1822 item 5 reversed)", () => {
    const { profileId, anchor } = makeProfile("rank-unified-capped");
    // Alcohol is the catalog's `limit` tier and the profile's heaviest recent log.
    for (let i = 0; i < 8; i++) {
      logServing(profileId, "alcohol", shiftDateStr(anchor, -i), 2);
    }
    const keys = rankFoodGroups(profileId, "Evening");
    expect(keys[0]).toBe("alcohol");
    expect(getFoodBarOrder(profileId, "Evening").groups[0].slug).toBe(
      "alcohol"
    );
  });

  it("an EXCLUDED group is the only demotion — tail, never removed", () => {
    const { profileId, anchor } = makeProfile("rank-unified-excluded");
    for (let i = 0; i < 8; i++) {
      logServing(profileId, "red_meat", shiftDateStr(anchor, -i), 2);
    }
    setProfileSetting(
      profileId,
      "dietary_excluded_groups",
      JSON.stringify(["red_meat"])
    );
    const keys = rankFoodGroups(profileId);
    // Top usage, still last — the user's own exclusion outranks frecency.
    expect(keys.at(-1)).toBe("red_meat");
    expect(keys).toHaveLength(foodGroupSlugs().length);
  });

  it("a non-tracker has no protein entry on either surface", () => {
    const { profileId } = makeProfile("rank-unified-noprotein");
    const keys = rankFoodGroups(profileId, "Morning");
    expect(keys).not.toContain(PROTEIN_NUDGE_KEY);
    expect(keys).toEqual(foodGroupSlugs());
    expect(getFoodBarOrder(profileId, "Morning").proteinRank).toBeNull();
  });
});

// ---- The slot axis is TWO-SIDED (#2369), through the REAL gather ----
//
// The pure decision is pinned in lib/__tests__/food-rank.test.ts; this drives it through
// the actual ledger read and proximity weighting, on the profile the issue describes: a
// drink logged night after night and never in the morning. Before #2369 that group took a
// morning quick slot on overall frecency alone, on the page AND in the nudge, because the
// slot axis could only ever boost.
describe("a never-eaten-here staple sinks in that window (#2369)", () => {
  let profileId: number;
  let anchor: string;

  beforeAll(() => {
    ({ profileId, anchor } = makeProfile("rank-slot-share"));
    // Default UTC timezone and default anchors (Morning 08:00, Evening 18:30), so a
    // 20:30Z tap is two hours from the evening anchor — well inside the four-hour
    // proximity span — and eleven and a half hours from the morning one, which is
    // outside it entirely. logFoodServingCore writes the day counter AND the event
    // ledger, so both halves of the blend see this history.
    for (let i = 0; i < 10; i++) {
      const date = shiftDateStr(anchor, -i);
      logFoodServingCore(profileId, "alcohol", date, `${date}T20:30:00Z`);
    }
    for (let i = 0; i < 4; i++) {
      const date = shiftDateStr(anchor, -i);
      logFoodServingCore(profileId, "leafy_greens", date, `${date}T08:00:00Z`);
    }
  });

  it("keeps it out of the MORNING quick six on both surfaces", () => {
    const keys = rankFoodGroups(profileId, "Morning");
    expect(keys[0]).toBe("leafy_greens");
    const six = keys.slice(0, FOOD_QUICK_COUNT);
    expect(six).not.toContain("alcohol");
    // The bar takes the same head of the same list (#2225), so the two agree by
    // construction rather than by coincidence.
    expect(
      getFoodBarOrder(profileId, "Morning")
        .groups.slice(0, FOOD_QUICK_COUNT)
        .map((g) => g.slug)
    ).toEqual(six);
    // Ordering only (#559): still present exactly once, one disclosure away.
    expect(keys.filter((k) => k === "alcohol")).toHaveLength(1);
    expect(keys).toHaveLength(foodGroupSlugs().length);
  });

  it("still LEADS the window it is actually eaten in", () => {
    // The same ledger read from the evening: presence is unchanged, and a heavily-logged
    // capped group still leads on frecency alone (#1980).
    expect(rankFoodGroups(profileId, "Evening")[0]).toBe("alcohol");
    // And with no window at all — the pure overall order — it leads too.
    expect(rankFoodGroups(profileId)[0]).toBe("alcohol");
  });
});
