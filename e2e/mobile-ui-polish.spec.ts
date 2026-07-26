import { test, expect } from "./fixtures";
import { expandTrendsContext } from "./trends-chrome";
import { expectNoClippedContent } from "./helpers";

// Mobile / touch-target polish (#640, #641, #644). Driven at a phone viewport so
// the clipping and undersized-target defects are observable — the desktop layout
// hides them. Reads/clicks only; the family-row check targets a seeded MEMBER
// login so it never deletes anything.
const PHONE = { width: 390, height: 844 };

test.describe("mobile tab strips scroll instead of clipping (#640)", () => {
  test.use({ viewport: PHONE });

  test("the last Trends tab (Insights) is reachable at 390px", async ({
    page,
  }) => {
    await page.goto("/trends");
    // Since #1485 F the strip lives inside the phone context bar and is collapsed
    // by default; expanded, it is the same scroller this has always asserted.
    await expandTrendsContext(page);

    // The strip must be its OWN horizontal scroll container — otherwise <main>'s
    // overflow-x-clip eats any trailing tab a narrower phone (or a longer strip)
    // pushes past the edge. This used to be asserted as "it genuinely overflows at
    // 390px", but #1489 cut the strip to five chips that FIT — the stronger
    // outcome, pinned by trends-compare-fold.mobile.spec.ts — so what survives here
    // is the scroller property itself plus the reachability of the last tab.
    const strip = page.getByRole("tablist");
    const overflowX = await strip.evaluate(
      (el) => getComputedStyle(el).overflowX
    );
    expect(["auto", "scroll"]).toContain(overflowX);
    // Nothing OUTSIDE that scroller sits past the right edge. Element-level
    // (#1543): the shell's clip makes a page-level width comparison read "no
    // overflow" on every page, so it could never have caught a regression here.
    await expectNoClippedContent(page);

    // The Insights tab — last in the strip — is clickable: Playwright scrolls the
    // strip to it, which was impossible when the strip was clipped, not scrollable.
    const insights = page.getByRole("tab", { name: "Insights" });
    // The tab is a real <a href> (#830), so the click navigates natively even in
    // the pre-hydration window — no toPass() retry needed.
    await insights.click();
    await expect(insights).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Date to analyze")).toBeVisible();
  });
});

test.describe("family login-row actions stay in the viewport (#641)", () => {
  test.use({ viewport: PHONE });

  test("a member login's Delete button is within the viewport and clickable", async ({
    page,
  }) => {
    await page.goto("/settings/family");

    // A seeded member login row (never the admin's, whose Delete is disabled).
    const row = page
      .getByTestId("login-row")
      .filter({ hasText: "e2e_child" })
      .first(); // first-ok: filtered to the e2e_child login row (this spec's fixture) — one match
    await expect(row).toBeVisible();

    const del = row.getByRole("button", { name: "Delete" });
    await expect(del).toBeVisible();
    await expect(del).toBeEnabled();

    // The button's right edge must not run off the 390px viewport (the clip bug:
    // the action group used to sit ~90–170px past the edge, unreachable).
    const box = await del.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);
    expect(box!.x).toBeGreaterThanOrEqual(0);
  });
});

test.describe("touch targets clear the 40px minimum (#644)", () => {
  test.use({ viewport: PHONE });

  test("the row kebab and dose circles have a >=40px hit box", async ({
    page,
  }) => {
    await page.goto("/nutrition?tab=supplements");

    // The overflow kebab is the sole per-row action affordance; every supplement
    // row renders one.
    const kebab = page.getByTestId("overflow-menu-trigger").first(); // first-ok: every supplement row renders one kebab (see comment) — order-agnostic
    await expect(kebab).toBeVisible();
    const kBox = await kebab.boundingBox();
    expect(kBox).not.toBeNull();
    expect(kBox!.width).toBeGreaterThanOrEqual(40);
    expect(kBox!.height).toBeGreaterThanOrEqual(40);

    // Dose take/skip circles render on any due, active dose. When present, both
    // clear 40px and don't overlap (a mis-tap between taken and skipped on a
    // medication is a real correctness cost). Scope BOTH circles to the SAME
    // dose-status control — a page-wide first-match on each testid can pair circles
    // from two different rows, whose boxes bear no spatial relation (the CI
    // failure mode this replaces).
    // The 40px sizing applies to the CIRCLE variant; the pill variant (compact
    // by design) also renders on this page, so target circles explicitly.
    const control = page
      .locator('[data-testid="dose-status"][data-variant="circle"]')
      .first(); // first-ok: one dose-status control; BOTH its circles are read from this SAME control (see comment) — order-agnostic
    if ((await control.count()) > 0) {
      const tBox = await control.getByTestId("dose-take").boundingBox();
      const sBox = await control.getByTestId("dose-skip").boundingBox();
      expect(tBox).not.toBeNull();
      expect(sBox).not.toBeNull();
      expect(tBox!.width).toBeGreaterThanOrEqual(40);
      expect(tBox!.height).toBeGreaterThanOrEqual(40);
      expect(sBox!.width).toBeGreaterThanOrEqual(40);
      // Within one control (a no-wrap flex row) the skip circle sits fully to
      // the right of the take circle, with the widened gap between them.
      expect(sBox!.x).toBeGreaterThanOrEqual(tBox!.x + tBox!.width);
    }
  });
});

test.describe("nutrition food-log controls stay in the viewport on mobile", () => {
  test.use({ viewport: PHONE });

  // The /nutrition two-column grid (lg:grid-cols-[1fr_320px]) collapses to a
  // single column below lg. A CSS grid item defaults to min-width:auto
  // (min-content), so without min-w-0 on the cells the column grew to the widest
  // food row's intrinsic width (~609px) and overflowed — <main>'s overflow-x-clip
  // then swallowed the +/- log controls off the right edge, making the page's
  // primary action untappable. min-w-0 lets the column shrink to the viewport.
  test("the +/- serving controls are within the 390px viewport", async ({
    page,
  }) => {
    await page.goto("/nutrition");

    // The one-tap logger renders for an adult profile (the seeded admin).
    await expect(page.getByTestId("food-log-bar")).toBeVisible();

    // The first row's add (+) button is the affordance that was clipped off-screen;
    // its right edge must stay within the viewport.
    const addBtn = page.locator('[data-testid^="log-"]').first(); // first-ok: the first log row's add button — the clip test is layout-general (see comment), order-agnostic
    await expect(addBtn).toBeVisible();
    const box = await addBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);
    expect(box!.x).toBeGreaterThanOrEqual(0);

    // And no OTHER element on the page is pushed off the right edge either
    // (#1543 — element-level, since the shell clips the page-level signal away).
    await expectNoClippedContent(page);
  });
});

test.describe("long unbreakable names wrap instead of clipping (#646)", () => {
  test.use({ viewport: PHONE });

  // A slash-joined combination-drug name behaves as one long token (no space to
  // break at) — the realistic case that overflowed the medicine row.
  const NAME =
    "Hydrochlorothiazide/Lisinopril/Amlodipine/Metoprolol/Atorvastatin/Losartan";

  test("a long-token item name stays within the 390px row", async ({
    page,
  }) => {
    await page.goto("/nutrition?tab=supplements");

    const addCard = page
      .locator("div.card")
      .filter({ hasText: "Add supplement" });
    await addCard.getByLabel("Name").fill(NAME);
    await addCard.getByLabel("Amount").first().fill("1 tab"); // first-ok: the first dose's Amount field in the add form this spec fills
    await addCard.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first dose's Time-of-day field in the add form this spec fills
    await addCard.getByRole("button", { name: "Add", exact: true }).click();

    const name = page
      .getByTestId("medicine-name")
      .filter({ hasText: "Hydrochlorothiazide" })
      .first(); // first-ok: filtered to the Hydrochlorothiazide med this spec added — one match
    await expect(name).toBeVisible();

    // The name box right edge stays within the viewport — it wraps (break-words)
    // rather than running off the clipped-right edge.
    const box = await name.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 1);

    // Clean up so the fixture is left as found.
    const row = page.locator("div.card").filter({ hasText: NAME });
    await row.getByRole("button", { name: "Supplement actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.locator("div.card").filter({ hasText: NAME })
    ).toHaveCount(0);
  });
});
