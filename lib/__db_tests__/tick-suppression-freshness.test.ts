// DB INTEGRATION TIER (issue #2674) — the finding-suppression bus stays UNMEMOIZED
// inside a notification tick scope.
//
// WHY THIS TEST EXISTS. `getFindingSuppressions` is read six times in one
// `gatherDigestInput` and eleven times across an ordinary two-profile tick, which is
// the exact shape lib/tick-cache.ts was built for — so the standing temptation is to
// declare `tickCached` on it and collapse those to one. #2674 proposed precisely
// that. It must not happen, because the tick scope does NOT satisfy the condition
// tick-cache.ts states before anything may be memoized in it: `runPreventive` writes
// this very table from inside the scope (the #1024 episode-end sweep —
// `clearPreventiveDismissal` at lib/notifications/preventive.ts:127, reached from
// scripts/notify.ts:605, which sits between the refill reader at :578 and the digest
// at :830), and the Telegram poll loop writes it from another process entirely while
// the scope stays open across every awaited dispatch.
//
// A memo would serve every later reader in the scope the pre-write snapshot, and a
// stale suppression map reads as "still silenced" — the direction that matters,
// because this map is what `isHiddenUnderPolicy` consults. So the contract pinned
// here is read-your-writes WITHIN an open tick scope. Wrapping the read in
// `tickCached` fails every case below.
//
// The cheap half of the duplication is already fixed and is not what this guards:
// the statement is hoisted (lib/queries/upcoming/suppressions.ts), so a repeat read
// costs a round-trip and no recompile.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  clearPreventiveDismissal,
  dismissFinding,
  getFindingSuppressions,
  restoreFinding,
  snoozeFinding,
} from "@/lib/queries/upcoming/suppressions";
import { preventiveDismissalKey } from "@/lib/dismissal-keys";
import { inTickScope, runInTickScope } from "@/lib/tick-cache";

// A real catalog rule, so `preventiveDismissalKey` resolves the kind prefix the way
// the nudge planner does rather than a key only this test believes in.
const PREVENTIVE_RULE = "dental_cleaning";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("finding suppressions inside a tick scope", () => {
  it("sees a dismissal written after an earlier read in the SAME scope", async () => {
    const profileId = makeProfile("Tick Dismiss");
    const key = "coaching:example-topic";

    await runInTickScope(
      async () => {
        // The scope must really be open, or every assertion below passes for the
        // wrong reason (outside a scope tickCached is a passthrough).
        expect(inTickScope()).toBe(true);

        expect(getFindingSuppressions(profileId).has(key)).toBe(false);
        dismissFinding(profileId, key);
        // The read that a memo would answer from the snapshot above.
        expect(getFindingSuppressions(profileId).has(key)).toBe(true);
      },
      { profileId }
    );
  });

  it("sees the preventive episode-end sweep clear a dismissal mid-scope", async () => {
    const profileId = makeProfile("Tick Preventive Sweep");
    const key = preventiveDismissalKey(PREVENTIVE_RULE);
    expect(key).not.toBeNull();

    // The #1024 state the sweep exists for: the user dismissed this episode's nag
    // indefinitely, and the rule has since stopped being actionable.
    dismissFinding(profileId, key!);

    await runInTickScope(
      async () => {
        expect(inTickScope()).toBe(true);
        // What the refill reader at scripts/notify.ts:578 sees, before the sweep.
        expect(getFindingSuppressions(profileId).has(key!)).toBe(true);

        // What runPreventive does at :605 — the writer the scope cannot exclude.
        clearPreventiveDismissal(profileId, PREVENTIVE_RULE);

        // What every reader after it — illness care, temp red flag, practices, the
        // coaching gather, the digest — must see. A memo would still say "silenced"
        // and hold the item out of the message for another tick.
        expect(getFindingSuppressions(profileId).has(key!)).toBe(false);
      },
      { profileId }
    );
  });

  it("sees a snooze and a restore written mid-scope", async () => {
    const profileId = makeProfile("Tick Snooze Restore");
    const key = "biomarker:ldl-cholesterol";

    await runInTickScope(
      async () => {
        expect(inTickScope()).toBe(true);
        snoozeFinding(profileId, key, "2099-01-01");
        expect(getFindingSuppressions(profileId).get(key)?.snooze_until).toBe(
          "2099-01-01"
        );
        restoreFinding(profileId, key);
        expect(getFindingSuppressions(profileId).has(key)).toBe(false);
      },
      { profileId }
    );
  });

  // NOT a restatement of the profile-scoping guards (lib/__tests__/profile-scoping,
  // lib/__db_tests__/upcoming.scoping): those prove the WHERE clause filters. This
  // proves the other half of a memo's contract, which only exists once someone adds
  // one — `tickCached` warns that `keyOf` must project every argument, and a key that
  // forgets the profile id would answer B with A's map while every case above still
  // passes. It is the one case here that survives a correctly-keyed memo, which is
  // what makes it worth stating separately: keying is not the reason the memo is
  // refused, freshness is.
  it("keeps one profile's mid-scope write out of another profile's map", async () => {
    const a = makeProfile("Tick Scope A");
    const b = makeProfile("Tick Scope B");
    const key = "coaching:cross-profile-check";

    await runInTickScope(
      async () => {
        dismissFinding(a, key);
        expect(getFindingSuppressions(a).has(key)).toBe(true);
        expect(getFindingSuppressions(b).has(key)).toBe(false);
      },
      { profileId: a }
    );
  });
});
