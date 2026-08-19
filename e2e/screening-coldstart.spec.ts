import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_PREVENTIVE,
  E2E_LOGIN_PREVENTIVE_LAPSED,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Onboarding cold start (issue #1433): a never-recorded screening is UNKNOWN, not
// overdue.
//
// The bug, observed on a real first install: the first dashboard a user ever sees
// opened with "Needs attention 14" — four red "Overdue — none on record" rows plus
// "+8 more overdue in Upcoming" — about a profile that was thirty seconds old. The
// only inputs were the age they had just typed in and the catalog's nominal
// interval. That is manufactured obligation: it buries the day-one onboarding card,
// and it teaches the reader that red on this hero means nothing.
//
// This spec pins BOTH halves of the fix, because either alone is a different bug:
//
//   1. ZERO EVIDENCE → no alarm. On a record-free profile no preventive row reaches
//      the hero's bands or its count, nothing anywhere says "overdue", and the rules
//      are still reachable — as ONE collapsed "Set up your screening history (N)"
//      line on the hero and their own trailing group on Upcoming.
//   2. EVIDENCE → alarm, unchanged. On a profile whose recorded history genuinely
//      lapsed, the same rules still band Overdue and still reach the hero.
//
// FIXTURE-OWNED per e2e hygiene (#868). Two dedicated member logins on two dedicated
// profiles, both READ-ONLY here (this spec never writes), so concurrent workers and
// --repeat-each can't contend and it never counts a shared-seed row:
//   • E2E_LOGIN_PREVENTIVE        — ~60yo female, NO satisfying records at all.
//   • E2E_LOGIN_PREVENTIVE_LAPSED — the same demographics with deep-past
//                                   preventive_events for dental + blood pressure.

test.describe.configure({ mode: "serial" });

test.describe("never-recorded screenings read as setup, not overdue (#1433)", () => {
  let cold: Page;
  let lapsed: Page;

  test.beforeAll(async ({ browser }) => {
    cold = await loginAs(browser, {
      username: E2E_LOGIN_PREVENTIVE,
      password: E2E_MEMBER_PASSWORD,
    });
    lapsed = await loginAs(browser, {
      username: E2E_LOGIN_PREVENTIVE_LAPSED,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await cold.close();
    await lapsed.close();
  });

  test("the cold-start Upcoming page groups them under setup, never Overdue", async () => {
    test.slow();
    await cold.goto("/upcoming");
    const main = cold.getByRole("main");

    // The trailing setup group exists and holds preventive rows.
    const setupGroup = main.locator("section#setup");
    await expect(setupGroup).toBeVisible();
    await expect(
      setupGroup.getByText("Set up your screening history")
    ).toBeVisible();
    const setupRows = setupGroup.locator(
      '[data-testid^="upcoming-item-screening:"], [data-testid^="upcoming-item-visit:"]'
    );
    expect(await setupRows.count()).toBeGreaterThan(0);

    // …and the Overdue band carries no preventive row (it usually does not exist
    // at all on this profile, which `toHaveCount(0)` covers either way).
    await expect(
      main.locator(
        'section#overdue [data-testid^="upcoming-item-screening:"], section#overdue [data-testid^="upcoming-item-visit:"]'
      )
    ).toHaveCount(0);

    // A setup row states the absence and offers the two ways out of it.
    const dental = setupGroup.getByTestId(
      "upcoming-item-visit:dental_cleaning"
    );
    await expect(dental).toBeVisible();
    await expect(dental).toContainText("No record yet");
    await expect(dental).not.toContainText(/overdue/i);
    await expect(dental.getByRole("link", { name: "Book" })).toBeVisible();
    await expect(
      dental.getByRole("button", { name: "Mark done" })
    ).toBeVisible();
  });

  test("a RECORDED history that lapsed still bands Overdue and reaches Now", async () => {
    test.slow();
    await lapsed.goto("/upcoming");
    const main = lapsed.getByRole("main");

    // The seeded 2011 cleaning is real evidence that a 6-month interval elapsed.
    // Since #2805 the row carries the assessor's own due date instead of a hard-set
    // band, so it says how far past it is ("N days overdue") rather than the bare word
    // the status fallback used to supply. The band is what this test is about, and the
    // row still has to say overdue in its own text — case-insensitively, because the
    // date-derived phrasing is a sentence fragment rather than a label.
    const dental = main
      .locator("section#overdue")
      .getByTestId("upcoming-item-visit:dental_cleaning");
    await expect(dental).toBeVisible();
    await expect(dental).toContainText(/overdue/i);
    await expect(dental).not.toContainText("No record yet");

    // The other seeded rule is the same story on the screening side.
    await expect(
      main
        .locator("section#overdue")
        .getByTestId("upcoming-item-screening:blood_pressure")
    ).toBeVisible();

    // And it remains prominent on the atomic dashboard rather than being reduced
    // to setup metadata or omitted with the retired composite hero.
    await lapsed.goto("/");
    const dentalAttention = dashboardCandidatePrefix(
      lapsed,
      "attention.fact:visit:dental_cleaning"
    );
    await expect(dentalAttention).toBeVisible();
    await expect(dentalAttention).toHaveAttribute("data-lane", "now");
  });
});
