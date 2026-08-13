import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  DORMANT_DOMAINS_PROFILE,
  E2E_LOGIN_DORMANT,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

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
//   4. A profile whose domains are current collapses nothing.
//
// The fixture profile is read-only by contract (e2e/seed/dashboard.ts:
// seedDormantDomains) — its whole value is an ABSENCE of recent records, which any
// neighbouring write would destroy. This spec therefore only READS, on both profiles.

const DORMANT_LINE = "widget-dormant-line";

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
  const weight = page.getByTestId("dashboard-widget-weight-trend");
  await expect(weight.getByTestId(DORMANT_LINE)).toHaveText(
    "No weigh-in recorded in 150 days"
  );
  const sleep = page.getByTestId("dashboard-widget-sleep-last-night");
  await expect(sleep.getByTestId(DORMANT_LINE)).toHaveText(
    "No sleep recorded in 150 days"
  );

  // Each collapsed card keeps its heading, so a reader navigating the page outline
  // still finds the section — only its height changed.
  await expect(
    weight.getByRole("heading", { name: "Weight trend" })
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

test("dormant and never-recorded are different sentences on the same page (#2652)", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DORMANT,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");

  // The onboarding CTA still renders for a domain that genuinely has nothing: this
  // profile has never logged food, so Nutrition today keeps its first-run invitation.
  const nutrition = page.getByTestId("dashboard-widget-nutrition-today");
  await expect(nutrition.getByTestId("widget-empty")).toBeVisible();
  await expect(nutrition).toContainText("No food logged yet");

  // …while the two dormant cards do NOT wear the onboarding component at all.
  for (const id of [
    "dashboard-widget-weight-trend",
    "dashboard-widget-sleep-last-night",
  ]) {
    const card = page.getByTestId(id);
    await expect(card.getByTestId("widget-dormant")).toBeVisible();
    await expect(card.getByTestId("widget-empty")).toHaveCount(0);
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
  const labs = page.getByTestId("dashboard-widget-recent-labs");
  await expect(labs.getByTestId("widget-dormant")).toHaveCount(0);
  await expect(labs).toContainText("Glucose");
  // Its rows still carry their age labels — the presentation floor's treatment, intact.
  await expect(labs.getByTestId("recent-lab-date")).not.toHaveCount(0);

  const vitals = page.getByTestId("dashboard-widget-vitals-latest");
  await expect(vitals.getByTestId("widget-dormant")).toHaveCount(0);
  await expect(vitals).toContainText("118");
  await expect(vitals.getByTestId("vitals-log-reading")).toBeVisible();

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
  await expect(page.getByTestId("widget-dormant")).toHaveCount(0);
  await expect(page.getByTestId(DORMANT_LINE)).toHaveCount(0);
  // Sanity that we are looking at a populated dashboard rather than an empty one, so
  // the zero above is an absence of dormancy and not an absence of cards.
  await expect(page.getByTestId("dashboard-widget-recent-labs")).toBeVisible();
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
