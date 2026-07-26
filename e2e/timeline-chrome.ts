import { expect, type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// The ONE way a spec reaches the Timeline's date-range control / category pills at
// phone width (issue #1517 B) — the sibling of e2e/trends-chrome.ts's
// expandTrendsContext, over the same shared components/ContextBar.
//
// Below `sm` those controls are collapsed behind the one-line filter bar ("All ·
// Through today ▾") and are genuinely `display: none`, so they are out of the
// accessibility tree — which is right for a collapsed disclosure and exactly why a
// locator for a pill (or the shared "Custom…" toggle) no longer resolves until the
// bar is opened. From `sm` up the toggle isn't rendered at all and the controls are
// simply there, so this is a no-op at desktop width and a spec can call it
// unconditionally.
//
// Idempotent (a second call on an open bar does nothing), so it is safe in a
// per-test helper that several assertions share.
export async function expandTimelineFilters(page: Page): Promise<void> {
  const bar = page.getByTestId("timeline-filters-bar");
  // Server-rendered, so this is present on the first paint — waiting on it also
  // gives the toggle probe below something deterministic to follow.
  await expect(bar).toBeVisible();
  const toggle = page.getByTestId("timeline-filters-toggle");
  if (!(await toggle.isVisible())) return; // `sm` and up: nothing to expand
  if ((await bar.getAttribute("data-expanded")) === "true") return;
  await hydratedClick(page, toggle);
  await expect(page.getByTestId("timeline-filters-controls")).toBeVisible();
}
