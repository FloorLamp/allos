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
// The Trends hub streams its Body / Fitness / Nutrition / Insights censuses below
// a fast head, so a census arrives in a `<div hidden id="S:n">` staging node and
// React moves it into its section a beat later (React batches boundary reveals —
// roughly a frame, longer on a loaded machine). Two consequences for a spec:
//
//   • A bare `getByTestId("body-metric-tiles")` right after `goto` can match the
//     STAGED copy (hidden), or — during the move — both copies, which is a strict-
//     mode violation rather than an honest wait.
//   • Anything scoped to the section (`trends-section-body`) is immune: the section
//     element lives in the shell, and the staged copy is not inside it.
//
// So: navigate, call this once, then assert freely. It resolves exactly when the
// census content is really in its section.
export async function censusRevealed(
  page: Page,
  section: "body" | "fitness" | "nutrition" | "insights",
  marker: string
): Promise<void> {
  await expect(
    page.getByTestId(`trends-section-${section}`).getByTestId(marker)
  ).toBeVisible();
}
