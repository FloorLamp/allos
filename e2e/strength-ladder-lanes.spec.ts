import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_LADDER_LANES,
  E2E_MEMBER_PASSWORD,
  LADDER_DECLINED_LIFT,
  LADDER_FLAT_LIFT,
  LADDER_PR_LIFT,
} from "./fixture-logins";

// BROWSER TIER for the Overview strength ladder's two dots (#3177) — the half of
// #3132/#3175 that nothing in a browser asserted.
//
// #3175 made both dots come from ONE measurement lane: the current dot is
// `freeWeightE1rmKg` (a machine-backed set states nothing against a barbell
// population table, #2326), so the prior dot is now taken from the SAME
// free-weight-restricted history. That is pinned at the DB tier (nine pins in
// lib/__db_tests__/strength-ladder-lanes.test.ts) and at the pure tier — but the
// ladder is a rendered thing, and none of those pins can see whether the dot, the
// suffix or the row order survives the trip through the page.
//
// THE FIXTURE IS THE HARD PART, and it has its own profile (e2e/seed/training.ts,
// seedStrengthLadderLanes). Three lifts, and the ladder keeps three rows, so this is
// the whole list:
//
//   Bench Press     machine 120×5 AND bar 50×5 at −100d, bar 60×5 at −2d
//                   → free-weight prior 50×5, current 60×5: the lift MOVED.
//   Back Squat      Smith machine 140×5 at −100d, bar 100×5 at −2d
//                   → NO comparable free-weight prior: one dot.
//   Overhead Press  bar 40×5 at −100d and at −2d
//                   → a real prior that did not move.
//
// FALSIFIED BY (verified before landing): dropping `freeWeightOnly: true` from the
// `getExerciseE1rmSeries` call inside `getStrengthLadder` (lib/queries/training/
// strength.ts) — i.e. reverting #3175. Each of the three tests below goes red on it,
// for its own reason: the machine prior towers over today's bar work, so Bench loses
// its "· PR", Back Squat grows a prior dot it must not have, and the movement sort
// falls apart. An e2e that passed with the fix reverted would pin nothing, which is
// the failure this whole thread has been about.

async function openLadder(browser: Parameters<typeof loginAs>[0]) {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_LADDER_LANES,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/training?tab=overview");
  const ladder = page.getByTestId("strength-standards-ladder");
  await expect(ladder).toBeVisible();
  return { page, ladder };
}

test("a lift whose pre-cutoff work was all machine gets NO prior dot", async ({
  browser,
}) => {
  // THE STATE THE FIX NEWLY PRODUCES, and the one a future change is most likely to
  // regress by helpfully filling the dot back in. The lifter's only pre-cutoff Back
  // Squat was on a Smith machine, so there is no free-weight standing to compare
  // against and the ladder says nothing about movement rather than inventing a
  // number the standards tables cannot read.
  const { page, ladder } = await openLadder(browser);
  try {
    const declined = ladder
      .getByTestId("strength-ladder-row")
      .filter({ hasText: LADDER_DECLINED_LIFT });
    await expect(declined).toHaveCount(1);
    // One dot, and it is the CURRENT one: absence of the prior is the claim, so the
    // present dot has to be named too or "no prior" would also pass on a row that
    // rendered nothing at all.
    await expect(declined.getByTestId("strength-ladder-current")).toHaveCount(
      1
    );
    await expect(declined.getByTestId("strength-ladder-prior")).toHaveCount(0);
    // Declining the prior is not the same as declaring a PR.
    await expect(declined).not.toContainText("· PR");
  } finally {
    await page.context().close();
  }
});

test("a free-weight PR keeps its prior dot and earns the '· PR' suffix", async ({
  browser,
}) => {
  // The masked-PR direction — the half of #3132 that fails SILENTLY rather than
  // visibly. The prior dot has to be there (the bar press 100 days back is a real
  // comparable point) AND it has to be the bar's number, which is what leaves room
  // for today's 60 kg to read as a PR at all.
  const { page, ladder } = await openLadder(browser);
  try {
    const pr = ladder
      .getByTestId("strength-ladder-row")
      .filter({ hasText: LADDER_PR_LIFT });
    await expect(pr).toHaveCount(1);
    await expect(pr.getByTestId("strength-ladder-prior")).toHaveCount(1);
    await expect(pr).toContainText("· PR");

    // The prior dot NAMES the number it was placed FROM (#4760) — the free-weight
    // e1RM of 50 kg × 5 (58.3 kg), never the machine's 120 kg × 5 (140 kg). Asserting
    // the number rather than the dot's presence is what makes this a LANE assertion:
    // the unfiltered series renders a dot here too, just the wrong one.
    await expect(pr.getByTestId("strength-ladder-prior")).toHaveAttribute(
      "aria-label",
      "About 90 days ago: 58.3 kg"
    );
    await expect(pr.locator("details, summary")).toHaveCount(0);

    // …and the control that gives "· PR" its meaning: a lift with a real free-weight
    // prior that did not move renders its prior dot and NO suffix. Without this, a
    // ladder that stamped every row "· PR" would pass the assertion above.
    const flat = ladder
      .getByTestId("strength-ladder-row")
      .filter({ hasText: LADDER_FLAT_LIFT });
    await expect(flat).toHaveCount(1);
    await expect(flat.getByTestId("strength-ladder-prior")).toHaveCount(1);
    await expect(flat).not.toContainText("· PR");
  } finally {
    await page.context().close();
  }
});

test("the top rows are ordered by movement, the moved lift first", async ({
  browser,
}) => {
  // The third thing #3175 fixed: `moved` is computed inside one lane, so it is also
  // the ladder's primary sort key. With the lanes crossed, the machine-inflated prior
  // holds `moved` false for the only lift that moved and the order collapses.
  const { page, ladder } = await openLadder(browser);
  try {
    const rows = ladder.getByTestId("strength-ladder-row");
    // Three lifts, three rows: nothing is truncated, so the order below is the whole
    // ranking rather than a window onto it.
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(LADDER_PR_LIFT); // eslint-disable-line no-restricted-properties -- first-ok: the ladder is a RANKED list and this asserts its head — the ordering is the property under test
    await expect(rows.nth(1)).toContainText(LADDER_DECLINED_LIFT);
    await expect(rows.nth(2)).toContainText(LADDER_FLAT_LIFT);
  } finally {
    await page.context().close();
  }
});
