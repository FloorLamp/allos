import { test, expect } from "./fixtures";
import { appContent, followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { dateStrInTz, shiftDateStr } from "@/lib/date";

// HOME IS THE RECORD'S DAY VIEW AT TODAY (#5435 §3), and these are the parts of §10's
// "prove" list that are structural rather than fixture-shaped: the day bar and its two
// directions, the record band's presence, the three additions that exist ONLY on today,
// and the nav change.
//
// WHY THESE AND NOT THE BAND CONTENTS. What the Later fold summarizes and which rows sit
// under the Now rule are decisions `lib/home-list.ts` owns and its own tests cover over
// the owner's schedule at four hours of one day — a browser is the wrong tier to re-ask
// that, and the answer moves with whatever the seeded profile happens to owe. What a
// browser is the only tier for is the SHAPE: that `/` and `/history?day=` render the
// same day view, that the additions are on one of them and not the other, and that the
// arrow between them goes where it says.
//
// SCOPED TO `appContent`, NOT `main`. Home renders through two Suspense boundaries and
// mounts overlay portals (the quick-log sheet, the day's selection bar), so a bare
// role-scoped locator can match a staged copy or a portal's node.

const today = () =>
  dateStrInTz(pinnedTimezone(frozenNow().toISOString()).zone, frozenNow());

test("Home is today's record: the day bar, the record band, and no forward arrow", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  const content = appContent(page);

  // The record's own day bar, naming today and counting it (§3.2).
  const bar = content.getByTestId("timeline-day-nav");
  await expect(bar).toContainText(/\d+ records?/);
  // NO FORWARD ARROW ON TODAY: there is no day after it to walk to. The previous
  // arrow is the ‹ that reaches every earlier day.
  await expect(bar.getByTestId("timeline-day-prev")).toBeVisible();
  await expect(bar.getByTestId("timeline-day-next")).toHaveCount(0);

  // The record band is the page's floor — present whatever the day holds.
  await expect(content.getByTestId("home-record")).toBeVisible();

  // The Now rule states the profile-local clock, once, between what is owed and what
  // is recorded.
  await expect(content.getByTestId("home-now-rule")).toHaveCount(1);
  await expect(content.getByTestId("home-now-rule")).toContainText(/^Now · /);
});

test("the ‹ arrow lands on yesterday's plain record: no rule, no Later row, chips back", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  const content = appContent(page);
  const yesterday = shiftDateStr(today(), -1);
  await followLink(
    page,
    content.getByTestId("timeline-day-prev"),
    new RegExp(`/history\\?day=${yesterday}`)
  );
  const past = appContent(page);
  // THE THREE ADDITIONS EXIST ONLY ON TODAY (§3.2, §6.6). A past day owes nothing and
  // forecasts nothing, so it carries neither the rule nor the fold.
  await expect(past.getByTestId("home-now-rule")).toHaveCount(0);
  await expect(past.getByTestId("home-later")).toHaveCount(0);
  // AND IT DOES CARRY THE KIND CHIPS, which are what replaced the add row there
  // (#5618 ruling 1) and which today does not have, because the Quicklogger is
  // today's door.
  await expect(past.getByTestId("history-add")).toBeVisible();
});

test("the nav lists Home and not History, and both record doors still serve", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" }).first();
  await expect(
    nav.getByRole("link", { name: "Home", exact: true })
  ).toHaveCount(1);
  await expect(
    nav.getByRole("link", { name: "History", exact: true })
  ).toHaveCount(0);

  // THE ROUTE STAYS. Removing the nav row is not removing the record: every other
  // door still points here, and both shapes of the page still render.
  await page.goto(`/history?day=${shiftDateStr(today(), -1)}`);
  await expect(appContent(page).getByTestId("history-page")).toBeVisible();
  await page.goto("/history");
  await expect(appContent(page).getByTestId("history-page")).toBeVisible();
  await expect(appContent(page).getByTestId("history-feed")).toBeVisible();
});
