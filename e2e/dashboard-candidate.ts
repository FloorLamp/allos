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
