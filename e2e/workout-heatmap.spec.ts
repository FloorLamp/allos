import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Issue #186: the workout-density heatmap on Trends → Fitness. The seed lays down
// 16 weeks of PPL strength sessions (3/week) for the login's profile, all with
// relative dates, so the trailing-12-month grid always has active cells. These
// specs prove the surface renders with ≥1 active day and that an active cell
// deep-links to that day's Timeline view (the sidebar calendar's pattern).
// Read-only — no mutations to self-clean.

test("Trends → Fitness renders the workout heatmap with active days (#186)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");

  const section = main.getByTestId("workout-heatmap-section");
  await expect(section).toBeVisible();
  await expect(section.getByText("Workout density")).toBeVisible();

  // At least one active (workout) day cell is present.
  const days = section.getByTestId("heatmap-day");
  expect(await days.count()).toBeGreaterThan(0);

  // The detail caption summarizes the window (sessions over N days).
  await expect(section.getByTestId("heatmap-detail")).toContainText(/session/);
});

test("a heatmap day deep-links to its Timeline view (#186)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");
  const section = main.getByTestId("workout-heatmap-section");
  await expect(section).toBeVisible();

  const first = section.getByTestId("heatmap-day").first(); // first-ok: asserts ANY heatmap cell's date/href FORMAT (regex below), not a specific day — order-agnostic
  const date = await first.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // Href follows the established Timeline day-anchor deep-link pattern.
  await expect(first).toHaveAttribute(
    "href",
    `/timeline?from=${date}&to=${date}#timeline-day-${date}`
  );

  // Following it lands on the Timeline with that day's section present. Use
  // followLink — a raw click intermittently lands in the pre-hydration swallow
  // window and never advances the URL, this spec's retries=0 flake (#889/#868).
  await followLink(page, first, new RegExp(`from=${date}`));
  await expect(
    page.getByRole("main").locator(`#timeline-day-${date}`)
  ).toBeVisible();
});
