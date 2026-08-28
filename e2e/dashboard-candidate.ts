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

/**
 * Open Standing's quiet tail (#3548) so the folded rows can be looked at.
 *
 * The fold hides rather than unmounts, so a text assertion reads through it and a
 * VISIBILITY assertion does not — which is the whole point of the band, and the
 * reason a spec that means "this row is still reachable" has to say so by opening
 * the fold. Silent when the surface has no tail, so a spec can call it without
 * asserting a band it does not care about.
 */
export async function openStandingTail(page: Page): Promise<void> {
  // IDEMPOTENT ON PURPOSE. A <details> toggles, so a second call would SHUT the fold
  // — and the rows would go hidden again with nothing in the failure to say why. Two
  // callers already reach for this twice on one page (a spec that opens the tail for
  // one row and again for another), so the state is checked rather than assumed.
  const tail = page.getByTestId("dashboard-standing-tail");
  if ((await tail.count()) === 0) return;
  if (await tail.evaluate((node) => (node as HTMLDetailsElement).open)) return;
  await page.getByTestId("dashboard-standing-tail-summary").click();
}
