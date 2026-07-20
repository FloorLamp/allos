// DB INTEGRATION TIER (#448) — a preventive dismissal must NOT outlive its due
// EPISODE (issue #1024). A preventive Upcoming item takes the "normal" lifecycle
// (dismissed → hidden indefinitely) and its `<kind>:<ruleKey>` dismissal key carries
// no cycle component, so before the fix, dismissing THIS episode's nag silently
// suppressed every FUTURE cycle's due on both the page and the push. These tests seed
// a realistic profile and prove the episode-scoped clear end-to-end against the real
// tables + query layer: dismiss now → suppressed now; a satisfying event (or the
// nudge's episode-end sweep) clears the dismissal → the next cycle's due surfaces
// fresh. Snoozes are left untouched; a lasting `not_applicable` override still wins.
// The pure key/plan layers are unit-tested in lib/__tests__.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  collectUpcoming,
  dismissFinding,
  snoozeFinding,
  recordPreventiveDone,
  setPreventiveOverride,
  clearPreventiveDismissal,
} from "@/lib/queries";

// A ~46-year-old male: past the colorectal screening entry age (45+), so
// `screening:colorectal_cancer` is a due item with no history on record. The
// colorectal rule recurs on a 10-year interval, so a satisfaction today comes due
// again ~10y out — the "next cycle" this bug is about.
function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, "1980-01-01");
  setUserSex(id, "male");
  return id;
}

const COLO_KEY = "screening:colorectal_cancer";
const COLO_RULE = "colorectal_cancer";

function dismissalRow(profileId: number, signalKey: string) {
  return db
    .prepare(
      `SELECT snooze_until, dismissed_at FROM upcoming_dismissals
         WHERE profile_id = ? AND signal_key = ?`
    )
    .get(profileId, signalKey) as
    { snooze_until: string | null; dismissed_at: string | null } | undefined;
}

let profileId: number;
let now: string;
// Well past a colorectal satisfaction's next-due (10y interval + grace): the "next
// cycle" instant, still inside the 45–76 screening window.
let nextCycle: string;

beforeEach(() => {
  profileId = makeProfile("Preventive Episode");
  now = today(profileId);
  nextCycle = shiftDateStr(now, 365 * 11);
});

describe("preventive dismissal is scoped to the due episode (issue #1024)", () => {
  it("a satisfying event retires the dismissal so the next cycle's due resurfaces", () => {
    // Due now.
    expect(
      collectUpcoming(profileId, now).some((i) => i.key === COLO_KEY)
    ).toBe(true);

    // Dismiss THIS episode's nag → hidden now (normal lifecycle: indefinite).
    dismissFinding(profileId, COLO_KEY);
    expect(
      collectUpcoming(profileId, now).some((i) => i.key === COLO_KEY)
    ).toBe(false);

    // The screening actually happens: recordPreventiveDone ends the episode AND
    // clears the dismissal in one write.
    recordPreventiveDone(profileId, COLO_RULE, now);
    expect(dismissalRow(profileId, COLO_KEY)).toBeUndefined();

    // Satisfied → not due right now.
    expect(
      collectUpcoming(profileId, now).some((i) => i.key === COLO_KEY)
    ).toBe(false);

    // The NEXT cycle comes due — and it is NOT silenced by last episode's dismissal.
    expect(
      collectUpcoming(profileId, nextCycle).some((i) => i.key === COLO_KEY)
    ).toBe(true);
  });

  it("without the satisfying event, a stale dismissal would still hide the next cycle (regression guard)", () => {
    // Dismiss and then advance time WITHOUT retiring it: the same indefinite
    // dismissal keeps hiding the (now overdue) item — this is exactly the state the
    // fix removes when the episode ends. Proves the suppression is real, not a no-op.
    dismissFinding(profileId, COLO_KEY);
    expect(
      collectUpcoming(profileId, nextCycle).some((i) => i.key === COLO_KEY)
    ).toBe(false);

    // Clearing it (the episode-end sweep) makes the overdue item reappear.
    clearPreventiveDismissal(profileId, COLO_RULE);
    expect(
      collectUpcoming(profileId, nextCycle).some((i) => i.key === COLO_KEY)
    ).toBe(true);
  });

  it("clearPreventiveDismissal leaves a SNOOZE untouched (snoozes self-expire)", () => {
    // A live snooze, not a dismiss.
    const until = shiftDateStr(now, 30);
    snoozeFinding(profileId, COLO_KEY, until);
    expect(dismissalRow(profileId, COLO_KEY)?.snooze_until).toBe(until);

    // The episode-end sweep only retires DISMISSALS (dismissed_at set) — the snooze row
    // survives so the user's time-boxed defer is preserved.
    clearPreventiveDismissal(profileId, COLO_RULE);
    const row = dismissalRow(profileId, COLO_KEY);
    expect(row?.snooze_until).toBe(until);
    expect(row?.dismissed_at).toBeNull();
  });

  it("a lasting not_applicable override still suppresses after a satisfying event (unaffected path)", () => {
    // The DESIGNED lasting opt-out lives in preventive_overrides, not in the dismissal
    // bus. Set it before satisfying; the next cycle must stay suppressed.
    setPreventiveOverride(profileId, COLO_RULE, "not_applicable");
    recordPreventiveDone(profileId, COLO_RULE, now);
    expect(
      collectUpcoming(profileId, nextCycle).some((i) => i.key === COLO_KEY)
    ).toBe(false);
  });

  it("clearing is scoped to the profile and an unknown rule key is a no-op", () => {
    const other = makeProfile("Episode Bystander");
    dismissFinding(profileId, COLO_KEY);
    dismissFinding(other, COLO_KEY);

    // Clearing on the first profile's rule must not touch the other profile's row.
    clearPreventiveDismissal(profileId, COLO_RULE);
    expect(dismissalRow(profileId, COLO_KEY)).toBeUndefined();
    expect(dismissalRow(other, COLO_KEY)?.dismissed_at).not.toBeNull();

    // An unknown rule key resolves to no signal key → nothing cleared, no throw.
    expect(() =>
      clearPreventiveDismissal(profileId, "not_a_real_rule")
    ).not.toThrow();
    expect(dismissalRow(other, COLO_KEY)?.dismissed_at).not.toBeNull();
  });
});
