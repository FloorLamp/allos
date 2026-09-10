// SERVER-ACTION TIER — the "Also for" gate (#5230). The copy writes to a profile the
// caller is not acting as, on a bottle that has no owning profile, so TWO gates must
// hold at once and only this tier can see them:
//
//   • the TARGET's own write access (requireProfileWriteAccess) — the same re-gate
//     linkItemAction applies to an item's profile, because the acting profile's
//     requireWriteAccess() would authorize the wrong person;
//   • the bottle's membership-management gate (#5560, requirePoolWriteAccess).
//
// And the point of the whole feature: the caller's ACTIVE profile is unchanged.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  alsoForAction,
  declineAlsoForAction,
} from "@/app/(app)/supplies/actions";
import { alsoForCardModel } from "@/lib/queries/intake/also-for";
import { createSharedSupply } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";
import { peekActingSession } from "./session-state";
import { alsoForOfferKey } from "@/lib/dismissal-keys";
import {
  alsoForDetectedSlugs,
  decodeAlsoForBasis,
  encodeAlsoForBasis,
} from "@/lib/intake-also-for";
import { getFindingSuppressions } from "@/lib/queries/upcoming/suppressions";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

let seq = 0;
const tag = (): string => `af${++seq}`;

function member(
  profileId: number,
  supplyId: number | null,
  kind: "medication" | "supplement" = "medication"
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, supply_id, source)
         VALUES (?, 'Ibuprofen', 1, ?, 'daily', 'must', ?, 'manual')`
      )
      .run(profileId, kind, supplyId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'morning', 'any', 0)`
  ).run(id);
  return id;
}

function bottle(): number {
  return createSharedSupply(
    {
      name: "Ibuprofen",
      strength: "200 mg",
      form: "tablet",
      lowSupplyDays: null,
      notes: null,
    },
    40
  );
}

function readOnly(loginId: number, profileId: number): void {
  db.prepare(
    "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
  ).run(loginId, profileId);
}

// What the card would post for this person, from the same model the page renders.
function post(
  supplyId: number,
  sourceProfileId: number,
  sourceItemId: number,
  target: { id: number; name: string }
): FormData {
  const model = alsoForCardModel({
    pool: { id: supplyId, name: "Ibuprofen", strength: "200 mg" },
    visibleMembers: [
      { itemId: sourceItemId, profileId: sourceProfileId, name: "Mira" },
    ],
    candidates: [target],
  });
  return fd({
    supply_id: supplyId,
    source_item_id: sourceItemId,
    source_profile_id: sourceProfileId,
    profile_id: target.id,
    basis: model.offers[0]?.bySource[sourceItemId]?.basis ?? "",
  });
}

function itemCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

describe("the copy is gated on the SUBJECT, and the caller stays who they are", () => {
  it("copies onto a granted profile without changing the active profile", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);

    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId);

    const res = await alsoForAction(post(supplyId, mira.id, sourceItem, ada));
    expect(res.ok).toBe(true);
    expect(res.receipt).toContain(`Added for Ada ${t}`);
    expect(res.href).toBeTruthy();
    expect(itemCount(ada.id)).toBe(1);
    // THE POINT OF THE FEATURE: the caller is still themselves.
    expect(peekActingSession()?.profile.id).toBe(mira.id);
  });

  it("refuses a target the caller may only read, and one they cannot reach", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const readOnlyTarget = createProfile(`Read ${t}`, login.id);
    readOnly(login.id, readOnlyTarget.id);
    const foreign = createProfile(`Foreign ${t}`);
    actAs(login, mira);

    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId);

    await expect(
      alsoForAction(post(supplyId, mira.id, sourceItem, readOnlyTarget))
    ).rejects.toThrow(/read-only on target/);
    await expect(
      alsoForAction(post(supplyId, mira.id, sourceItem, foreign))
    ).rejects.toThrow(/not accessible/);
    expect(itemCount(readOnlyTarget.id)).toBe(0);
    expect(itemCount(foreign.id)).toBe(0);
  });

  it("refuses a bottle whose members the caller may only read", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const ada = createProfile(`Ada ${t}`, login.id);
    const theirs = createProfile(`Their ${t}`, login.id);
    readOnly(login.id, theirs.id);
    actAs(login, ada);

    const supplyId = bottle();
    const sourceItem = member(theirs.id, supplyId);

    await expect(
      alsoForAction(post(supplyId, theirs.id, sourceItem, ada))
    ).rejects.toThrow(/read-only on target/);
    expect(itemCount(ada.id)).toBe(0);
  });

  it("refuses a bottle the caller cannot reach at all", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const ada = createProfile(`Ada ${t}`, login.id);
    const stranger = createProfile(`Stranger ${t}`);
    actAs(login, ada);

    const supplyId = bottle();
    const sourceItem = member(stranger.id, supplyId);

    const res = await alsoForAction(
      post(supplyId, stranger.id, sourceItem, ada)
    );
    expect(res.ok).toBe(false);
    expect(itemCount(ada.id)).toBe(0);
  });

  // A BOTTLE THE CALLER CAN SEE, CARRYING A MEMBER THEY CANNOT.
  //
  // THE FIXTURE'S DISTINGUISHING PROPERTY IS THAT `isLinkableSupply` PASSES. In the
  // test above the bottle itself is invisible, so the linkability check refuses first
  // and the source's profile is never examined — that test cannot reach this case, and
  // a fixture drifted back into it would prove nothing. Here the caller's OWN member
  // makes the bottle linkable, and `poolMembers` is cross-profile by construction
  // (lib/queries/intake/supply-pool.ts), so a forged POST may name any member of it —
  // including another login's household member, whose plan the caller has no read on.
  // `!scope.ids.includes(sourceProfileId)` is then the ENTIRE defence, and the honest
  // tap at the end is what holds the fixture in place: it lands, so the bottle really
  // was visible. Do not delete it, and do not unlink the caller's own member.
  it("refuses a member the caller cannot see, on a bottle they can", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const ada = createProfile(`Ada ${t}`, login.id);
    const bo = createProfile(`Bo ${t}`, login.id);
    const otherLogin = createLogin({ role: "member", username: `o_${t}` });
    const theirs = createProfile(`Zed ${t}`, otherLogin.id);
    actAs(login, ada);

    const supplyId = bottle();
    const ownItem = member(ada.id, supplyId);
    const hiddenItem = member(theirs.id, supplyId);
    // A plan the caller can reach no other way — the one the exploit pulled across.
    db.prepare(
      "UPDATE intake_items SET cadence_kind = 'weekly', cadence_weekdays = '1,3,5' WHERE id = ?"
    ).run(hiddenItem);

    const forged = await alsoForAction(
      post(supplyId, theirs.id, hiddenItem, bo)
    );
    expect(forged.ok).toBe(false);
    expect(forged.reason).toBe("no-bottle");
    expect(itemCount(bo.id)).toBe(0);

    // The same bottle, from the member the caller CAN see, lands — so the refusal above
    // was the source's profile and not an unreachable bottle — and what it wrote is
    // Ada's daily plan, never the hidden member's weekly one.
    const honest = await alsoForAction(post(supplyId, ada.id, ownItem, bo));
    expect(honest.ok).toBe(true);
    expect(
      db
        .prepare(
          "SELECT cadence_kind, cadence_weekdays FROM intake_items WHERE profile_id = ?"
        )
        .all(bo.id)
    ).toEqual([{ cadence_kind: "daily", cadence_weekdays: null }]);
  });
});

// The decline touches the RECIPIENT's suppression row, so it carries the same two gates
// as the tap — the target's own write access and the bottle's membership-management
// gate — even though it writes no health data and no membership.
describe("declining an offer is gated the same way the tap is", () => {
  it("declines for a granted profile and leaves everything else alone", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);
    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId);

    // The offer the person is holding, captured BEFORE the decline — the tap they were
    // already mid-way through must refuse by name rather than land.
    const held = post(supplyId, mira.id, sourceItem, ada);

    const res = await declineAlsoForAction(
      fd({ supply_id: supplyId, profile_id: ada.id })
    );
    expect(res.ok).toBe(true);
    expect(itemCount(ada.id)).toBe(0);
    expect(peekActingSession()?.profile.id).toBe(mira.id);
    expect(
      getFindingSuppressions(ada.id).has(
        alsoForOfferKey(supplyId, alsoForDetectedSlugs("Ibuprofen"))
      )
    ).toBe(true);

    // …and the offer the person was holding no longer lands.
    const tap = await alsoForAction(held);
    expect(tap.ok).toBe(false);
    expect(tap.reason).toBe("declined");
    expect(itemCount(ada.id)).toBe(0);
  });

  it("refuses a target the caller may only read", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const readOnlyTarget = createProfile(`Read ${t}`, login.id);
    readOnly(login.id, readOnlyTarget.id);
    actAs(login, mira);
    const supplyId = bottle();
    member(mira.id, supplyId);

    await expect(
      declineAlsoForAction(
        fd({ supply_id: supplyId, profile_id: readOnlyTarget.id })
      )
    ).rejects.toThrow(/read-only on target/);
    expect(
      getFindingSuppressions(readOnlyTarget.id).has(
        alsoForOfferKey(supplyId, alsoForDetectedSlugs("Ibuprofen"))
      )
    ).toBe(false);
  });
});

// ── THE REFRESH IS THE MECHANISM, and nothing red-able covered it ───────────────
//
// Executed against the banked branch: deleting
// `if (alsoForRefusalRefreshes(result.reason)) revalidateSupplies();` left all 41
// db/action tests and all 10 component tests green. That one line is the whole of
// ruling 3's midnight guarantee and ruling 6's "tap again": without it the card keeps
// the stale basis, so the next tap refuses for the same reason, forever.
describe("a refusal a fresh render fixes also refreshes the card", () => {
  // `day-rolled` is the cheapest of the refreshing reasons and the one that changes on
  // its own: an offer rendered at 23:59 and tapped at 00:01 must not refuse forever.
  it("revalidates the cabinet on a day-rolled refusal", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);
    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId);

    const held = post(supplyId, mira.id, sourceItem, ada);
    const shown = decodeAlsoForBasis(String(held.get("basis")));
    expect(shown).not.toBeNull();
    if (!shown) return;
    held.set("basis", encodeAlsoForBasis({ ...shown, day: "2000-01-01" }));

    revalidate.mockClear();
    const res = await alsoForAction(held);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("day-rolled");
    expect(itemCount(ada.id)).toBe(0);
    expect(revalidate).toHaveBeenCalled();
  });

  // A bottle deleted between render and tap refreshes the card too (PM, 18:45 UTC).
  // ONE reason and ONE message across deleted, foreign and unreachable: if only a truly
  // deleted bottle refreshed, the refresh would be an oracle telling a caller that a
  // bottle they may not see exists.
  it("revalidates on a missing bottle, from both doors", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);

    revalidate.mockClear();
    const tap = await alsoForAction(
      fd({
        supply_id: 0,
        source_item_id: 0,
        source_profile_id: 0,
        profile_id: ada.id,
        basis: "",
      })
    );
    expect(tap.reason).toBe("no-bottle");
    expect(revalidate).toHaveBeenCalled();

    revalidate.mockClear();
    const declined = await declineAlsoForAction(
      fd({ supply_id: 0, profile_id: ada.id })
    );
    expect(declined.reason).toBe("no-bottle");
    expect(revalidate).toHaveBeenCalled();
  });
});

// ── "Open their row" must land on THEIR row, or not be offered ──────────────────
describe("the receipt's link", () => {
  // A medication has a cross-profile detail page, so the link is the recipient's own
  // row and reads correctly for anyone who may see them.
  it("points at the recipient's own medication row", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);
    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId);

    const res = await alsoForAction(post(supplyId, mira.id, sourceItem, ada));
    expect(res.ok).toBe(true);
    const [created] = db
      .prepare("SELECT id FROM intake_items WHERE profile_id = ?")
      .all(ada.id) as { id: number }[];
    expect(res.href).toBe(`/medications/${created.id}`);
  });

  // A SUPPLEMENT has no cross-profile route: every supplement door resolves to
  // /nutrition?tab=supplements, which is the CALLER's own tab, and the nutrition page
  // reads no profile parameter. Linking there shows the wrong person's supplements, so
  // the link is not offered at all and the receipt's "set the amount on the new row"
  // stands. Rules out shipping a link to somebody else's stack.
  it("is absent for a cross-profile supplement copy, and present for the caller's own", async () => {
    const t = tag();
    const login = createLogin({ role: "member", username: `m_${t}` });
    const mira = createProfile(`Mira ${t}`, login.id);
    const ada = createProfile(`Ada ${t}`, login.id);
    actAs(login, mira);
    const supplyId = bottle();
    const sourceItem = member(mira.id, supplyId, "supplement");

    const cross = await alsoForAction(post(supplyId, mira.id, sourceItem, ada));
    expect(cross.ok).toBe(true);
    expect(cross.receipt).toBeTruthy();
    expect(cross.href).toBeUndefined();

    // The SAME copy for the caller's own profile does land on a page that shows it,
    // so the link stands there. Rules out dropping the link for every supplement.
    const t2 = tag();
    const login2 = createLogin({ role: "member", username: `m_${t2}` });
    const bo = createProfile(`Bo ${t2}`, login2.id);
    const cass = createProfile(`Cass ${t2}`, login2.id);
    actAs(login2, cass);
    const supply2 = bottle();
    const source2 = member(bo.id, supply2, "supplement");

    const own = await alsoForAction(post(supply2, bo.id, source2, cass));
    expect(own.ok).toBe(true);
    expect(own.href).toBe("/nutrition?tab=supplements");
  });
});
