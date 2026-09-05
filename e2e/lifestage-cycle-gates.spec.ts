import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_CYCLE_PREGNANT,
  E2E_MEMBER_PASSWORD,
  TODDLER_PROTOCOL_NAME,
} from "./fixture-logins";

// Life-stage and cycle-state gating (issues #2801 / #2807). Two bugs of one shape: a
// surface stating something about a profile that the profile's OWN recorded state
// contradicts — a cycle day for someone 20 weeks pregnant, a PHQ-9 for a 22-month-old.
//
// Every assertion here is an ABSENCE, which is the only way to test a gate. Both
// fixtures are therefore in a KNOWN state that would make the offer appear if the gate
// were missing: the pregnant profile has a real period history (the derivation runs and
// produces "Day 141 · Follicular" without the suspension), and Riley has an ordinary
// records shell (every other specialty pane still renders). A profile with no history
// would pass these tests with the fix reverted.
//
// Fixture hygiene (#868): the pregnancy fixture is dedicated and READ-ONLY — the writes
// under test are the ones that must not be offered, so nothing here mutates it and
// --repeat-each starts from the same place. The toddler half reuses E2E_LOGIN_CHILD
// (the seeded ~18-month-old "Riley (child)" is its sole/active profile), also read-only.

test.describe("a recorded pregnancy suspends the cycle state (#2801)", () => {
  test("the Cycle hero shows the pause instead of a day, a phase, and a period button", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_PREGNANT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medical/cycles");
      const status = page.getByTestId("cycle-status");
      await expect(status).toBeVisible();

      // THE BUG: this read "Follicular", with "Day 141 · Follicular" under the
      // control, off a period that ended before conception.
      await expect(page.getByTestId("cycle-current-phase")).toHaveText("—");
      await expect(page.getByTestId("cycle-state-line")).toHaveCount(0);
      await expect(page.getByTestId("cycle-state-suspended")).toContainText(
        /paused while a pregnancy is recorded/i
      );

      // And the offer is gone — a full-width "Period started today" is exactly the
      // claim the recorded pregnancy contradicts.
      await expect(page.getByTestId("period-started-button")).toHaveCount(0);
      await expect(page.getByTestId("period-reopen-button")).toHaveCount(0);

      // The forecast card said this all along; the hero now agrees with it.
      await expect(page.getByTestId("cycle-forecast-suspended")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

test.describe("life-stage gates past substance use (#2807)", () => {
  // #3065 gated the Longevity surfaces; #3133 drew the finer line #3067's ruling
  // requires on the case #3065 did not anticipate — a protocol record the profile
  // OWNS (the supersede-in-prose pattern #3092 used on #2264). The HUB half of
  // #3065 stands: Longevity is adult-only CONTENT, so the route and its nav entry
  // stay unreachable at any ineligible age. But the profile's own recorded
  // experiment is a data fact, never filtered from that profile — its detail page
  // renders READ-ONLY plus end/delete (#2993's fasting line: closing or removing
  // one's own record is always allowed; creating, editing, and resuming are
  // adult-gated, so their affordances are withheld rather than rendering forms
  // the server refuses).
  test("a toddler cannot reach the Longevity hub, but its own protocol record renders (#3065/#3133)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The hub: redirected away, no fitness section, no nav entry.
      await page.goto("/longevity");
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId("longevity-fitness")).toHaveCount(0);
      // #3079 made Longevity a child of the collapsed "Plan & review" group. Expand
      // it — and prove the expansion with an ungated sibling — so this absence is
      // still the ADULT-ONLY gate being observed and not a closed disclosure.
      // Trends (#4965), not History — History left this group for a top-level row.
      const sidebarNav = page.locator("aside nav");
      await sidebarNav.getByRole("button", { name: "Plan & review" }).click();
      await expect(
        sidebarNav.getByRole("link", { name: "Trends" })
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Longevity" })).toHaveCount(
        0
      );

      // A protocol that is NOT this profile's record is still nothing — the
      // (profile, id) scope 404s a guessed id rather than redirecting, exactly
      // as it does for an adult.
      await page.goto("/protocols/999999");
      await expect(page.getByTestId("app-not-found")).toBeVisible();

      // The record the toddler OWNS (seeded ended, past the reopen window — the
      // state where an adult WOULD be offered "Run again"): its page renders by
      // direct URL instead of redirecting.
      const handle = new Database(workerDbPath(), { readonly: true });
      let ownProtocolId: number;
      try {
        ownProtocolId = (
          handle
            .prepare(
              `SELECT p.id FROM protocols p
                 JOIN profiles pr ON pr.id = p.profile_id
                WHERE pr.name = 'Riley (child)' AND p.name = ?`
            )
            .get(TODDLER_PROTOCOL_NAME) as { id: number }
        ).id;
      } finally {
        handle.close();
      }
      await page.goto(`/protocols/${ownProtocolId}`);
      await expect(page.getByTestId("protocol-detail-page")).toBeVisible();
      await expect(page.getByTestId("protocol-header")).toContainText(
        TODDLER_PROTOCOL_NAME
      );

      // Delete (record-following) stands; Edit and "Run again" (record-
      // rewriting / creating — their actions refuse at this age) are withheld.
      await hydratedClick(
        page,
        page.getByRole("button", { name: "More protocol actions" })
      );
      const menu = page.getByRole("menu");
      await expect(
        menu.getByRole("menuitem", { name: "Delete" })
      ).toBeVisible();
      await expect(menu.getByTestId("protocol-edit")).toHaveCount(0);
      await expect(
        menu.getByRole("menuitem", { name: "Run again" })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("a toddler is not offered PHQ-9/GAD-7 — the route re-gates like substance use", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // A direct URL is the whole point: the nav gate was cosmetic, so before #2807
      // "the only protection was not knowing the URL".
      await page.goto("/records/specialty/mental-health");
      await expect(page).toHaveURL(/\/records\/specialty\/hearing$/);
      await expect(page.getByTestId("records-mental-health")).toHaveCount(0);
      await expect(page.getByTestId("instruments-form")).toHaveCount(0);
      await expect(
        page.getByTestId("add-mental-health-screening-panel-toggle")
      ).toHaveCount(0);

      // The gate is targeted, not a blanket shutdown of the records shell: the
      // ungated specialty panes still serve this profile.
      await expect(page.getByTestId("records-hearing")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("a toddler gets an explanation on /medical/cycles, never the tracking UI", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medical/cycles");
      // An empty state rather than the substance-use bounce: "irrelevant" here also
      // covers a profile whose sex simply is not filled in, and bouncing those would
      // leave no way to start tracking. So the page stays, and says why.
      await expect(page.getByTestId("cycle-not-applicable")).toBeVisible();
      // None of the tracking UI renders — least of all the period button.
      await expect(page.getByTestId("period-started-button")).toHaveCount(0);
      await expect(page.getByTestId("cycle-status")).toHaveCount(0);
      await expect(page.getByTestId("cycle-add-panel")).toHaveCount(0);
      await expect(page.getByTestId("cycle-forecast")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
