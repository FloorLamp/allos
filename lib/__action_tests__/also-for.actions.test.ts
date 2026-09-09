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

import { describe, expect, it } from "vitest";
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
import { getFindingSuppressions } from "@/lib/queries/upcoming/suppressions";

let seq = 0;
const tag = (): string => `af${++seq}`;

function member(profileId: number, supplyId: number | null): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, supply_id, source)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'must', ?, 'manual')`
      )
      .run(profileId, supplyId).lastInsertRowid
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
    expect(getFindingSuppressions(ada.id).has(alsoForOfferKey(supplyId))).toBe(
      true
    );

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
      getFindingSuppressions(readOnlyTarget.id).has(alsoForOfferKey(supplyId))
    ).toBe(false);
  });
});
