import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// Issue #186's two questions, asked of the surface that now answers them.
//
// #186 shipped a workout-density heatmap; #2415 replaced it outright with the
// day-history substrate (calendar + matrix). The heatmap's spec died with the
// component, but its QUESTIONS did not, and deleting them with the markup would
// have quietly dropped desktop coverage of the tab's lead surface:
//
//   1. Does Trends → Fitness render a density view with active days?
//   2. Can a reader get from a day to that day's Timeline?
//
// The second one's ANSWER changed, which is the point of re-asking it here.
// The heatmap made every active cell an anchor, so a tap navigated away. The
// day-history calendar makes a cell a BUTTON that SELECTS: the day panel opens
// in place and carries the Timeline link, so the deep link is still one tap
// away but no longer ambushes a reader who only wanted to see what a day held.
// A spec that just checked `href` on a cell would now pass on markup that had
// silently lost the route entirely.
//
// The mobile lens spec (trends-fitness-lens.mobile) covers the same section's
// WINDOWING; this is the desktop render + navigation pair. The seed lays down
// 16 weeks of PPL strength sessions (3/week) on relative dates, so the grid
// always has active cells. Read-only — no mutations to self-clean.

test("Trends → Fitness leads with the workout history and its active days (#186/#2415)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");

  const section = main.getByTestId("workout-history");
  await expect(section).toBeVisible();

  // The CALENDAR half — "how consistently did I train".
  const calendar = section.getByTestId("day-history-calendar");
  await expect(calendar).toBeVisible();
  expect(await calendar.getByTestId("day-history-day").count()).toBeGreaterThan(
    0
  );

  // The MATRIX half — "what was it", the question a day total cannot answer.
  // At least one named activity row, which is what #2415 added over the heatmap.
  await expect(section.getByTestId("day-history-row")).not.toHaveCount(0);
});

test("selecting a day opens its panel, which links to that day's Timeline (#186/#2415)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");
  const section = main.getByTestId("workout-history");
  await expect(section).toBeVisible();

  const cal = section.getByTestId("day-history-calendar");
  const day = cal.getByTestId("day-history-day").first(); // first-ok: asserts ANY active cell's date format and panel, not a specific day — order-agnostic
  const date = await day.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // A cell SELECTS rather than navigating (#2415): the URL must not move.
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(date!);
  await expect(page).toHaveURL(/tab=fitness/);

  // The Timeline route survives the change — one link away, in the panel.
  const link = panel.getByRole("link", { name: /Timeline/ });
  await expect(link).toHaveAttribute(
    "href",
    `/timeline?from=${date}&to=${date}#timeline-day-${date}`
  );

  // followLink, not a raw click — a raw click intermittently lands in the
  // pre-hydration swallow window and never advances the URL, this spec's
  // retries=0 flake (#889/#868).
  await followLink(page, link, new RegExp(`from=${date}`));
  await expect(
    page.getByRole("main").locator(`#timeline-day-${date}`)
  ).toBeVisible();
});
