import { test, expect } from "@playwright/test";
import { hydratedClick } from "./helpers";

// Trends "charts above the fold" on a phone (#1455). The page used to spend ~1.9
// screens on chrome before the first chart: the always-open From/To card, a
// quick-range row carrying a duplicate range chip, a second full row of saved
// views, then seven mover pills and the StarredBiomarkers status card. All four
// are layout-only changes — no store, no schema, no query touched — so the only
// tier that can see them is a browser at phone width.
//
// Runs in the `mobile` project (390×844) by its file name alone; the desktop
// project testIgnores `*.mobile.spec.ts`.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed — every test navigates
// and toggles client state, writes nothing, and asserts no exact count of a
// shared-seed row, so it is repeat-safe under `--repeat-each` and perturbs no
// neighbor (the smoke.mobile.spec.ts precedent). The one mover-count assertion is
// an upper BOUND (≤ the lead cap), which holds however many movers the seed or a
// neighbor's dismissal leaves.

const LEAD_CHIPS = 3; // mirrors TrendingDigest's inline cap

test.describe("the custom From/To form collapses behind a Custom… pill (A)", () => {
  test("collapsed by default, with the quick-range row as the primary control", async ({
    page,
  }) => {
    await page.goto("/trends");

    // The chip row is what a phone gets first.
    await expect(page.getByRole("link", { name: "30D" })).toBeVisible();

    const toggle = page.getByTestId("custom-range-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The panel is in the DOM (the form's server-rendered defaults never leave)
    // but not shown — that is the ~230px this reclaims.
    await expect(page.getByTestId("custom-range-panel")).toBeHidden();
    await expect(page.locator("#trends-from")).toBeHidden();
  });

  test("tapping Custom… expands the From/To form", async ({ page }) => {
    await page.goto("/trends");

    const toggle = page.getByTestId("custom-range-toggle");
    await hydratedClick(page, toggle);

    await expect(page.getByTestId("custom-range-panel")).toBeVisible();
    await expect(page.locator("#trends-from")).toBeVisible();
    await expect(page.locator("#trends-to")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("a shared ?from= URL lands with the form already expanded", async ({
    page,
  }) => {
    // A custom window matches no quick-range pill, so hiding its dates behind the
    // pill would make a shared link unreadable.
    await page.goto("/trends?from=2026-01-01&to=2026-02-01");

    const panel = page.getByTestId("custom-range-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("custom-range-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    // The dates are the whole reason it opens. DateField shows a friendly label in
    // its text box and submits the ISO value from a hidden input, so assert the
    // canonical one.
    await expect(panel.locator('input[name="from"]')).toHaveValue("2026-01-01");
    await expect(panel.locator('input[name="to"]')).toHaveValue("2026-02-01");
    await expect(page.locator("#trends-from")).toBeVisible();
  });

  test("the Timeline gets the same collapse from the shared control", async ({
    page,
  }) => {
    // DateRangeControl is shared, so this is the regression guard for the OTHER
    // surface that mounts it (the metric detail pages are the third).
    await page.goto("/timeline");

    await expect(page.getByTestId("custom-range-toggle")).toBeVisible();
    await expect(page.getByTestId("custom-range-panel")).toBeHidden();
    await expect(page.locator("#timeline-from")).toBeHidden();
  });
});

test.describe("Overview leads with charts (B)", () => {
  test("a chart tile sits inside the opening viewport", async ({ page }) => {
    await page.goto("/trends");
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Presence + "reachable without scrolling", not a pixel offset: toBeInViewport
    // asks exactly the question the issue does (is the payload above the fold?)
    // without pinning a number that ordinary content changes would break.
    const tile = page.getByTestId("trend-mini-card").first(); // first-ok: the grid's topmost tile is the subject — "is the FIRST chart above the fold?"
    await expect(tile).toBeVisible();
    await expect(tile).toBeInViewport();
  });

  test("the StarredBiomarkers status card is gone from Trends but stays on Results → Biomarkers", async ({
    page,
  }) => {
    await page.goto("/trends");
    await expect(page.getByTestId("trend-mini-card").first()).toBeVisible(); // first-ok: any tile proves the Overview grid rendered before asserting an absence
    await expect(page.getByTestId("starred-biomarkers")).toHaveCount(0);

    // Its one remaining card surface still renders it — the store and the lens are
    // untouched, only this page's layout changed.
    await page.goto("/results/biomarkers");
    await expect(page.getByTestId("starred-biomarkers")).toBeVisible();
  });

  test("the movers card leads with the top few behind a show-all disclosure", async ({
    page,
  }) => {
    await page.goto("/trends");
    const digest = page.getByTestId("trending-digest");
    await expect(digest).toBeVisible();

    // An upper BOUND, not an exact count (#868: never exact-count a shared-seed
    // row) — however many movers this window yields, at most LEAD_CHIPS of them
    // may render inline. That cap IS the change.
    const inline = digest.getByTestId("digest-dismiss");
    await expect.poll(() => inline.count()).toBeLessThanOrEqual(LEAD_CHIPS);

    // The seed yields more movers than the cap, so the disclosure renders; opening
    // it reveals the rest into the same chip row.
    const showAll = digest.getByTestId("digest-show-all");
    await expect(showAll).toBeVisible();
    const capped = await inline.count();
    await hydratedClick(page, showAll);
    await expect.poll(() => inline.count()).toBeGreaterThan(capped);
  });
});

test.describe("one chip row, one range chip (C + D)", () => {
  test("the saved views ride the quick-range row instead of a second row", async ({
    page,
  }) => {
    await page.goto("/trends");

    await expect(page.getByRole("link", { name: "All time" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save current" })
    ).toBeAttached();

    // "Merged into one row" stated structurally: the "All time" pill and the saved
    // views' "Save current" now resolve to the SAME horizontal scroll container.
    // Before, the views owned a second, separate full-width row.
    const sameRow = await page.evaluate(() => {
      const scrollerOf = (el: Element | null) => {
        for (let a = el; a; a = a.parentElement) {
          const o = getComputedStyle(a).overflowX;
          if (o === "auto" || o === "scroll") return a;
        }
        return null;
      };
      const pill = Array.from(document.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "All time"
      );
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save current")
      );
      const a = scrollerOf(pill ?? null);
      return a != null && a === scrollerOf(btn ?? null);
    });
    expect(sameRow).toBe(true);
  });

  test("the range-summary chip renders only for a custom window", async ({
    page,
  }) => {
    // A preset is lit → the chip would only repeat the pill's own label (the
    // duplicate "All time").
    await page.goto("/trends");
    await expect(page.getByText("All time", { exact: true })).toHaveCount(1);

    // A custom window has no pill naming it, so the chip carries real information.
    await page.goto("/trends?from=2026-01-01&to=2026-02-01");
    await expect(
      page.getByText("2026-01-01 → 2026-02-01", { exact: true })
    ).toBeVisible();
  });
});
