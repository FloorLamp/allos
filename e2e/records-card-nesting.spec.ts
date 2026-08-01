import { test, expect } from "./fixtures";

// The Records hub is a set of lists and focused summaries, not a dashboard of
// containers inside containers. Expand every native disclosure on every pane and
// reject visible `.card` descendants of another `.card`; a card may frame a real
// record or table, but its parent must remain layout rather than another surface.
const RECORD_PANES = [
  "/records/history/visits",
  "/records/history/procedures",
  "/records/history/immunizations",
  "/records/problems/conditions",
  "/records/problems/allergies",
  "/records/care/overview",
  "/records/care/providers",
  "/records/specialty/vision",
  "/records/specialty/dental",
  "/records/specialty/skin",
  "/records/specialty/mental-health",
  "/records/specialty/substance-use",
] as const;

test("Records panes do not render cards inside cards", async ({ page }) => {
  test.slow();

  for (const href of RECORD_PANES) {
    await page.goto(href);
    await expect(page.getByTestId("records-group-tabs")).toBeVisible();

    await page.locator("details").evaluateAll((details) => {
      for (const detail of details) (detail as HTMLDetailsElement).open = true;
    });

    const nested = await page
      .locator(".card .card:visible")
      .evaluateAll((cards) =>
        cards.map((card) => ({
          className: card.className,
          testId: card.getAttribute("data-testid"),
          text: card.textContent?.trim().slice(0, 80),
        }))
      );
    expect(nested, `nested card surfaces on ${href}`).toEqual([]);
  }
});
