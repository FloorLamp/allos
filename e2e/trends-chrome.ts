import { expect, type Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// The ONE way a spec reaches the Trends range pills at phone width. The primary
// tab strip now stays visible and does not require this helper.
//
// Below `sm` the range controls are collapsed behind the fixed range trigger
// ("90D ▾") and are genuinely `display: none`. From `sm` up the toggle isn't
// rendered and the controls are simply there, so this remains a no-op at desktop
// width and a spec can call it unconditionally.
//
// Idempotent (a second call on an open bar does nothing), so it is safe in a
// per-test helper that several assertions share.
export async function expandTrendsContext(page: Page): Promise<void> {
  const bar = page.getByTestId("trends-context-bar");
  // Server-rendered, so this is present on the first paint — waiting on it also
  // gives the toggle probe below something deterministic to follow.
  await expect(bar).toBeVisible();
  const toggle = page.getByTestId("trends-context-toggle");
  if (!(await toggle.isVisible())) return; // `sm` and up: nothing to expand
  if ((await bar.getAttribute("data-expanded")) === "true") return;
  await hydratedClick(page, toggle);
  await expect(page.getByTestId("trends-context-controls")).toBeVisible();
}

// `censusRevealed` lived here between #1644 landing and the harness-level
// streamed-reveal guard replacing it. The class it patched per spec — a census
// testid matching both the hidden staged copy and the revealed one while React's
// Suspense reveal is pending — is now closed for EVERY spec by
// `installStreamRevealGuard` (e2e/helpers.ts), which the `browser` fixture
// installs on every page of every context: full-document navigations return only
// after the staging nodes are gone. Specs assert census content directly.
