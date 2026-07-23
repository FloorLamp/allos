import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_ILLNESS_CARE } from "./fixture-logins";

// Illness-care care finding (issue #805). The dedicated ILLNESS_CARE fixture
// (seed-events.ts) makes its sole (active) profile currently sick — an ongoing
// "Illness" situation with a FEVER logged on four consecutive days (daysAgo 3→0),
// which crosses the cited "more than 3 days" line. The care-tier finding surfaces on
// Upcoming (the deterministic planning surface) via the SAME unified attention model
// the dashboard "Needs attention" hero subsets — so this asserts the model end-to-end
// where the render is cap-independent.
//
// Fixture ownership (#868): profile 1 carries the same 4-day-fever fixture, but the
// illness lifecycle specs mutate profile 1's illness state (end/reopen episode, dismiss
// the finding), so under --repeat-each a sibling made the finding vanish for the reader.
// This spec signs in as the dedicated read-only sick profile instead, so the finding is
// deterministic — the ONE illness-care item, no positional pick needed.
//
// The finding must state the logged FACT + the cited LINE + the SOURCE, and carry
// the mandatory "informational, not medical advice" tail — never a diagnosis.

test("a 4-day fever surfaces a cited illness-care finding on Upcoming", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ILLNESS_CARE,
    password: E2E_MEMBER_PASSWORD,
  });

  await page.goto("/upcoming");
  const main = page.getByRole("main");

  // The illness-care row (domain-prefixed testid; the key carries the episode
  // anchor + symptom). The dedicated fixture owns exactly one, so this is exact.
  const row = main.locator('[data-testid^="upcoming-item-illness-care:"]');
  await expect(row).toBeVisible();

  // The logged fact.
  await expect(row).toContainText("Fever logged 4 days running");
  // The cited line + the source + the mandatory disclaimer tail.
  await expect(row).toContainText("more than 3 days");
  await expect(row).toContainText("Source:");
  await expect(row).toContainText("Informational, not medical advice.");

  await page.context().close();
});
