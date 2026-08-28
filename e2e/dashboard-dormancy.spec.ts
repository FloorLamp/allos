import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expectPhoneTapTargets } from "./helpers";
import {
  DORMANT_DOMAINS_PROFILE,
  E2E_LOGIN_DORMANT,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import {
  dashboardCandidatePrefix,
  openStandingTail,
} from "./dashboard-candidate";

// Issue #2652 behavior 2 — "dormancy collapses, loudly".
//
// Four claims, and the middle two are the reason this feature exists at all:
//   1. A domain that RECORDED and then went quiet collapses to one line that states
//      how long, and carries the fix.
//   2. That line is not the onboarding line. Before this, the weight card answered a
//      profile with a fortnight of weigh-ins 150 days back with "No weigh-ins yet",
//      because its own window is 90 days and an empty window read as an empty domain.
//      "It stopped" and "there has never been any" are different sentences.
//   3. The collapse STOPS where a card is still showing a value. On the same profile,
//      Recent labs (400 days old) and Latest vitals (200) keep their full cards and
//      their numbers under their declared presentation floors — the fix is what a card
//      claims, never what it hides (#1216/#2303).
//      #3226 moved where that stop SITS for vitals without moving the rule: a vitals
//      row now does collapse, but only past a YEAR, which is the point past which it
//      renders no value and so has nothing left to hide. 200 days is inside that floor,
//      so this profile still pins the stated claim — and pins it at an age that is
//      unambiguously stale, which is the part that matters.
//   4. A profile whose domains are current collapses nothing.
//
// The fixture profile is read-only by contract (e2e/seed/dashboard.ts:
// seedDormantDomains) — its whole value is an ABSENCE of recent records, which any
// neighbouring write would destroy. This spec therefore only READS, on both profiles.

test("a quiet domain collapses to one line that states how long, and offers the fix (#2652)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DORMANT,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dashboard", level: 1 })
  ).toBeVisible();

  // Both collapsible domains, at the 90-day default, with their last record 150 days
  // back. Each sentence is pinned verbatim — the day count comes from the fixture's own
  // offset, so a changed threshold or a reworded line fails here rather than passing
  // against a recomputed expectation.
  const weight = dashboardCandidatePrefix(page, "weight.dormant");
  await expect(weight).toContainText("No weigh-in recorded in 150 days");
  await expect(weight).toHaveAttribute("data-presence", "dormant");
  const sleep = dashboardCandidatePrefix(page, "sleep.dormant");
  await expect(sleep).toContainText("No sleep recorded in 150 days");
  await expect(sleep).toHaveAttribute("data-presence", "dormant");

  // #3548 NARROWED #3226 EXACTLY THIS FAR: a dormant line keeps its existence, its
  // copy and its affordance, and loses the always-visible slot. So it is inside the
  // quiet tail, and everything below is asserted with the tail open.
  await expect(
    page.locator('[data-standing-band="tail"] [data-standing-family="weight"]')
  ).toHaveCount(1);
  await openStandingTail(page);
  await expect(page.locator('[data-standing-family="weight"]')).toBeVisible();

  // REACH IS UNCHANGED: each collapsed line carries the link that would end the
  // silence, so what it replaced is one tap away.
  await expect(
    sleep.getByRole("link", { name: /Sync a source/ })
  ).toBeVisible();
  await expect(
    weight.getByRole("link", { name: /Body metrics/ })
  ).toBeVisible();

  await page.close();
});

test("dormant domains never regress to never-recorded copy (#2652)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DORMANT,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");

  // The two dormant facts do not wear never-recorded presence.
  for (const id of ["weight.dormant", "sleep.dormant"]) {
    await expect(dashboardCandidatePrefix(page, id)).toHaveAttribute(
      "data-presence",
      "dormant"
    );
  }

  // The specific lie this replaces. The weight card's onboarding copy is "No weigh-ins
  // yet"; on a profile with fourteen recorded weigh-ins it may never appear again.
  await expect(page.getByRole("main")).not.toContainText("No weigh-ins yet");

  await page.close();
});

test("a card still showing a stale value is NOT collapsed (#2652)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DORMANT,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");

  // Labs 400 days old and vitals 200 days old, on the very profile whose weight and
  // sleep just collapsed. Both cards declare a presentation floor that keeps the value
  // on screen with an age label (#1216/#2303), and dormancy may not undo that — so
  // these stay full cards, with their numbers and their write.
  //
  // The blood pressure here is 20 days past its own 180-day floor and 165 short of the
  // year at which #3226 retires it: the exact span where the row is stale AND still a
  // number. A dormancy rule that fired on staleness rather than on the year floor would
  // turn this row dormant and redden this test.
  await openStandingTail(page);
  const labs = dashboardCandidatePrefix(page, "labs.latest:").filter({
    hasText: "Glucose",
  });
  await expect(labs).toHaveAttribute("data-presence", "current");
  await expect(labs).toContainText("Glucose");

  const vitals = dashboardCandidatePrefix(page, "vitals.blood-pressure:");
  await expect(vitals).toHaveAttribute("data-presence", "current");
  await expect(vitals).toContainText("118");
  await page.close();
});

test("a profile whose domains are current collapses nothing (#2652)", async ({
  page,
}) => {
  test.slow();
  // The shared admin profile records weight and sleep on a live cadence. The negative
  // control that keeps the collapse from degenerating into "always fold": no dormant
  // line anywhere on its dashboard, and its cards render as they always did.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Dashboard", level: 1 })
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="dashboard-candidate"][data-presence="dormant"]')
  ).toHaveCount(0);
  // Sanity that we are looking at a populated dashboard rather than an empty one, so
  // the zero above is an absence of dormancy and not an absence of cards. A quiet
  // clinical result sits in the tail now (#3548), so the fold is opened to see it.
  await openStandingTail(page);
  await expect(
    dashboardCandidatePrefix(page, "labs.latest:").filter({
      hasText: "LDL Cholesterol",
    })
  ).toBeVisible();
});

test("the fixture profile is the one being read (#2652)", async ({
  browser,
}) => {
  // Cheap guard that the tests above are looking at the fixture and not at some
  // fallback profile — a mis-granted login would otherwise make every assertion above
  // pass or fail for the wrong reason.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DORMANT,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/profile");
  await expect(page.getByRole("main")).toContainText(DORMANT_DOMAINS_PROFILE);
  await page.close();
});

// ── The quiet tail itself (#3548) ────────────────────────────────────────────
//
// This fixture is the one that can show all three bands at once: three domains that
// recorded and went quiet, one that never recorded, and live rows beside them. The
// fold is asserted at BOTH viewports because the band is structural, not a phone
// affordance.
for (const [label, viewport] of [
  ["a phone", { width: 390, height: 844 }],
  ["a desktop", { width: 1280, height: 900 }],
] as const) {
  test(`Standing's quiet tail folds on ${label} and keeps its rows reachable`, async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DORMANT,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(viewport);
    await page.goto("/");

    const tail = page.getByTestId("dashboard-standing-tail");
    await expect(tail).toBeVisible();
    await expect(tail).toHaveJSProperty("open", false);
    const summary = page.getByTestId("dashboard-standing-tail-summary");
    await expect(summary).toHaveText(/^Quiet \(\d+\)$/);

    // Hidden, not unmounted — the dormant weight line is in the document while the
    // fold is shut, and its own copy is intact.
    const dormantWeight = dashboardCandidatePrefix(page, "weight.dormant");
    await expect(dormantWeight).toHaveCount(1);
    await expect(dormantWeight).not.toBeVisible();
    await expect(dormantWeight).toContainText("No weigh-in recorded in 150 days");

    if (viewport.width === 390)
      await expectPhoneTapTargets(page, "the Standing fold control", [summary]);

    await summary.click();
    await expect(tail).toHaveJSProperty("open", true);
    await expect(dormantWeight).toBeVisible();
    await expect(
      dormantWeight.getByRole("link", { name: /Body metrics/ })
    ).toBeVisible();

    // THE CONVERSE, in the same test and for the reason the brief gives: "the
    // dormant line left the open page" is equally true of a page whose Standing
    // collapsed entirely. These are the rows that must STILL stand above the fold.
    for (const family of ["blood-pressure", "resting-heart-rate"])
      await expect(
        page.locator(
          `[data-standing-band="rest"] [data-standing-family="${family}"]`
        )
      ).toBeVisible();

    await page.close();
  });
}
