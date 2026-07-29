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

// Wait for a streamed census section to be REVEALED (#1644).
//
// The Trends landing surface streams its body census below a fast head, so the
// census arrives in a `<div hidden id="S:n">` staging node and React moves it into
// its section a beat later — React BATCHES boundary reveals (~a frame, longer on a
// loaded machine). Two consequences for a spec, and this helper closes both:
//
//   • Before the move, a bare `getByTestId("body-metric-tiles")` matches the STAGED
//     copy, which is hidden — an assertion that waits out its timeout on visibility.
//   • DURING the move both copies exist for an instant, which is a strict-mode
//     violation that reads like a duplicated-testid bug rather than the timing it is.
//
// So the wait has two halves. Scoping to `trends-section-<id>` proves the REAL copy
// is in place (the section element lives in the page shell, never in the staged
// copy); the page-wide count proves the STAGED copy is gone, which is the half a
// scoped assertion cannot see. `marker` must therefore be a testid that is unique
// page-wide once revealed (`trends-body`, `body-metric-tiles`).
//
// Navigate, call this once, then assert freely.
export async function censusRevealed(
  page: Page,
  section: "body",
  marker: string
): Promise<void> {
  await expect(
    page.getByTestId(`trends-section-${section}`).getByTestId(marker)
  ).toBeVisible();
  await expect(page.getByTestId(marker)).toHaveCount(1);
}
