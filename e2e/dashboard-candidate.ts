import type { Locator, Page } from "@playwright/test";

export function dashboardCandidatePrefix(page: Page, prefix: string): Locator {
  return page.locator(
    `[data-testid="dashboard-candidate"][data-candidate-id^="${prefix}"]`
  );
}

export function dashboardCandidateWithText(
  page: Page,
  prefix: string,
  text: string | RegExp
): Locator {
  return dashboardCandidatePrefix(page, prefix).filter({ hasText: text });
}

// THERE IS NO SECOND OPENER (#4232). `openStandingTail` lived here while the page had
// two folds; Standing has none now, so every spec that wants a quiet row opens the ONE
// fold through `openDashboardAll` in ./helpers. Keeping a second helper alive would be
// keeping the second fold alive in the specs after the page retired it.
