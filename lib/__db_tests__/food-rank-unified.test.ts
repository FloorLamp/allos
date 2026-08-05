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

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getFoodBarOrder, rankFoodGroups } from "@/lib/queries";
import { addProteinGramsCore } from "@/lib/protein-log-write";
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
