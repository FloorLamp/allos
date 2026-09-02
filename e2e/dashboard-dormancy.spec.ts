import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expectPhoneTapTargets, openDashboardAll } from "./helpers";
import {
  DORMANT_DOMAINS_PROFILE,
  E2E_LOGIN_DORMANT,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { dashboardCandidatePrefix } from "./dashboard-candidate";

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
//      Recent labs (400 days old), a blood pressure (200) and a resting heart rate (60)
//      keep their full cards and their numbers under their declared presentation floors
//      — the fix is what a card claims, never what it hides (#1216/#2303).
//      #3226 moved where that stop SITS for vitals without moving the rule: a vitals
//      row now does collapse, but only past its own horizon, which is the point past
//      which it renders no value and so has nothing left to hide. #3250 then split that
//      horizon by cadence — a year for the episodic cuff, 90 days for the daily stream
//      — so the two seeded ages are different on purpose. Each is inside its own
//      horizon and past its own floor, so this profile still pins the stated claim at
//      an age that is unambiguously stale, which is the part that matters.
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

  // #3548 NARROWED #3226 EXACTLY THIS FAR, AND #4232 MOVED WHERE THE FOLD IS: a
  // dormant line keeps its existence, its copy and its affordance, and loses the
  // always-visible slot. It is now in the page's ONE fold, in the Read group its own
  // model routes it to, and everything below is asserted with that fold open.
  await expect(
    page
      .getByTestId("dashboard-standing")
      .locator('[data-candidate-id="weight.dormant"]')
  ).toHaveCount(0);
  await openDashboardAll(page);
  await expect(
    page
      .getByTestId("dashboard-everything-read")
      .locator('[data-candidate-id="weight.dormant"]')
  ).toBeVisible();

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

  // Labs 400 days old and a blood pressure 200 days old, on the very profile whose
  // weight and sleep just collapsed. Both cards declare a presentation floor that keeps
  // the value on screen with an age label (#1216/#2303), and dormancy may not undo that
  // — so these stay full cards, with their numbers and their write.
  //
  // The blood pressure here is 20 days past its own 180-day floor and 165 short of the
  // year at which #3226 retires it: the exact span where the row is stale AND still a
  // number. A dormancy rule that fired on staleness rather than on the year floor would
  // turn this row dormant and redden this test. Its resting-heart-rate neighbour holds
  // the same span against a much shorter horizon (60 days, floor 14, collapse 90), and
  // the row below asserts it is still standing.
  await openDashboardAll(page);
  const labs = dashboardCandidatePrefix(page, "labs.latest:").filter({
    hasText: "Glucose",
  });
  await expect(labs).toHaveAttribute("data-presence", "current");
  await expect(labs).toContainText("Glucose");

  const vitals = dashboardCandidatePrefix(page, "vitals.blood-pressure:");
  await expect(vitals).toHaveAttribute("data-presence", "current");
  await expect(vitals).toContainText("118");
  // The stream row, on its own shorter horizon (#3250): stale by its 14-day floor,
  // still 30 days short of collapsing, so it is a value here and not a dormant line.
  const hr = dashboardCandidatePrefix(page, "vitals.resting-heart-rate:");
  await expect(hr).toHaveAttribute("data-presence", "current");
  await expect(hr).toContainText("58");
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
  // clinical result sits in the page's one fold now (#4232), so it is opened to see it.
  await openDashboardAll(page);
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

// ── ONE fold (#4232, narrowing #3548) ────────────────────────────────────────
//
// This fixture is the one that can show the whole split at once: three domains that
// recorded and went quiet, one that never recorded, and live rows beside them. It is
// asserted at BOTH viewports because the arrangement is structural, not a phone
// affordance.
for (const [label, viewport] of [
  ["a phone", { width: 390, height: 844 }],
  ["a desktop", { width: 1280, height: 900 }],
] as const) {
  test(`the dashboard folds once on ${label} and keeps its quiet rows reachable`, async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DORMANT,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(viewport);
    await page.goto("/");

    // EXACTLY ONE fold on the page, and it is Show everything. Standing draws none.
    const folds = page.getByRole("main").locator("details");
    await expect(folds).toHaveCount(1);
    const tail = page.getByTestId("dashboard-all");
    await expect(tail).toHaveCount(1);
    await expect(tail).toHaveJSProperty("open", false);
    await expect(page.getByTestId("dashboard-standing-tail")).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-standing").locator("details")
    ).toHaveCount(0);

    // Hidden, not unmounted — the dormant weight line is in the document while the
    // fold is shut, and its own copy is intact.
    const dormantWeight = dashboardCandidatePrefix(page, "weight.dormant");
    await expect(dormantWeight).toHaveCount(1);
    await expect(dormantWeight).not.toBeVisible();
    await expect(dormantWeight).toContainText(
      "No weigh-in recorded in 150 days"
    );

    const summary = tail.locator("summary");
    if (viewport.width === 390)
      await expectPhoneTapTargets(page, "the dashboard fold control", [
        summary,
      ]);

    await openDashboardAll(page);
    await expect(dormantWeight).toBeVisible();
    await expect(
      dormantWeight.getByRole("link", { name: /Body metrics/ })
    ).toBeVisible();
    // …in the Read group, which is where the exact-once partition routes a dormant
    // reading once Standing stops claiming it.
    await expect(
      page
        .getByTestId("dashboard-everything-read")
        .locator('[data-candidate-id="weight.dormant"]')
    ).toHaveCount(1);

    // THE CONVERSE, in the same test and for the reason the brief gives: "the dormant
    // line left the open page" is equally true of a page whose Standing collapsed
    // entirely and took everything with it. These are the rows that must STILL stand
    // above the fold, asserted through the same band locator.
    for (const family of ["blood-pressure", "resting-heart-rate"])
      await expect(
        page.locator(
          `[data-standing-band="rest"] [data-standing-family="${family}"]`
        )
      ).toBeVisible();

    await page.close();
  });
}
