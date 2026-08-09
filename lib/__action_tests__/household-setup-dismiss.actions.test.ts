// SERVER-ACTION TIER — the member setup row's dismiss (issue #2173).
//
// The compare-and-swap on the episode key is the point of this action: a dismissal means
// "not THIS set of problems", so a key that no longer matches the member's current
// failing set must not write one. What this file pins is the OTHER half — that every
// refusal is still VISIBLE. A refusal that neither writes nor revalidates leaves the user
// with a Dismiss tap that does nothing and a page that does not even re-render, which is
// the quiet twin of confirming a success unconditionally. Revalidating re-renders the
// card against the CURRENT failing set, which is this surface's own way of saying "that
// is not the row you were looking at".

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { dismissMemberSetupAction } from "@/app/(app)/household/actions";
import { db, today } from "@/lib/db";
import { setTelegramBotConfig } from "@/lib/settings";
import { householdSetupForProfile } from "@/lib/queries/household-setup";
import { seedActor, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => {
  revalidate.mockClear();
  // An instance WITH channel technology configured, so the #2362 instance gate is open
  // and the unroutable case below is reachable at all.
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
});

const revalidatedHousehold = () =>
  revalidate.mock.calls.some((c) => c[0] === "/household");

// A dosed, active, non-`may` supplement — the send source that makes a profile with no
// route UNROUTABLE rather than quiet.
function seedDosedItem(profileId: number): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Setup Vitamin D', 1, 'supplement', 'daily', 'should')`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(itemId);
}

describe("dismissMemberSetupAction (#2173)", () => {
  it("dismisses the row when the posted key IS the current episode", async () => {
    const { login } = seedActor();
    // A bare profile: no onboarding row and no stored data, so the only failing check is
    // never-onboarded — a dismissible set.
    const member = createProfile("Setup Member", login.id);
    const row = householdSetupForProfile(member.id, today(member.id))!;
    expect(row.dismissible).toBe(true);

    await dismissMemberSetupAction(
      fd({ profileId: member.id, dedupe_key: row.dedupeKey })
    );

    expect(householdSetupForProfile(member.id, today(member.id))).toBe(null);
    expect(revalidatedHousehold()).toBe(true);
  });

  it("a STALE key writes nothing and still revalidates, so the tap has a consequence", async () => {
    const { login } = seedActor();
    const member = createProfile("Stale Card Member", login.id);
    const row = householdSetupForProfile(member.id, today(member.id))!;

    // The card was rendered against a different failing set — the key the browser posts
    // no longer describes the member.
    await dismissMemberSetupAction(
      fd({
        profileId: member.id,
        dedupe_key: `${row.dedupeKey}+undosed-items`,
      })
    );

    // Nothing silenced: the row is still offered under its own key.
    expect(
      householdSetupForProfile(member.id, today(member.id))?.dedupeKey
    ).toBe(row.dedupeKey);
    // …and the page re-renders against the current set rather than sitting there.
    expect(revalidatedHousehold()).toBe(true);
  });

  it("a NON-dismissible (unroutable) row refuses the write and still revalidates", async () => {
    const { login } = seedActor();
    const member = createProfile("Unroutable Member", login.id);
    seedDosedItem(member.id);
    const row = householdSetupForProfile(member.id, today(member.id))!;
    expect(row.checks.map((c) => c.id)).toContain("unroutable");
    expect(row.dismissible).toBe(false);

    // A hand-posted form carrying the row's real key must not silence it either.
    await dismissMemberSetupAction(
      fd({ profileId: member.id, dedupe_key: row.dedupeKey })
    );

    expect(
      householdSetupForProfile(member.id, today(member.id))?.checks.map(
        (c) => c.id
      )
    ).toContain("unroutable");
    expect(revalidatedHousehold()).toBe(true);
  });

  it("a post naming NO member does nothing at all — there is no card to re-render", async () => {
    seedActor();
    await dismissMemberSetupAction(fd({ dedupe_key: "household-setup:x" }));
    expect(revalidatedHousehold()).toBe(false);
  });
});
