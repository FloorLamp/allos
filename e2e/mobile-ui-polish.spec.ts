import { test, expect } from "@playwright/test";

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

    // The strip overflows the viewport (6 tabs), so it must be its OWN scroll
    // container — otherwise <main>'s overflow-x-clip eats the trailing tabs.
    const strip = page.getByRole("tablist");
    const { scrollW, clientW } = await strip.evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    expect(scrollW).toBeGreaterThan(clientW); // genuinely overflowing
    // The page body itself does NOT scroll sideways (the clip backstop holds).
    const bodyOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(bodyOverflow).toBe(true);

    // The Insights tab — last in the strip — is clickable: Playwright scrolls the
    // strip to it, which was impossible when the strip was clipped, not scrollable.
    const insights = page.getByRole("tab", { name: "Insights" });
    // Retry the click until selection sticks: under local `next dev` a click can
    // land in the pre-hydration window and be swallowed (CI's `next start`
    // hydrates fast enough that one click suffices).
    await expect(async () => {
      await insights.click();
      await expect(insights).toHaveAttribute("aria-selected", "true", {
        timeout: 1_000,
      });
    }).toPass();
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
      .first();
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
    await page.goto("/medicine");

    // The overflow kebab is the sole per-row action affordance; every supplement
    // row renders one.
    const kebab = page.getByTestId("overflow-menu-trigger").first();
    await expect(kebab).toBeVisible();
    const kBox = await kebab.boundingBox();
    expect(kBox).not.toBeNull();
    expect(kBox!.width).toBeGreaterThanOrEqual(40);
    expect(kBox!.height).toBeGreaterThanOrEqual(40);

    // Dose take/skip circles render on any due, active dose. When present, both
    // clear 40px and don't overlap (a mis-tap between taken and skipped on a
    // medication is a real correctness cost). Scope BOTH circles to the SAME
    // dose-status control — page-wide .first() on each testid can pair circles
    // from two different rows, whose boxes bear no spatial relation (the CI
    // failure mode this replaces).
    // The 40px sizing applies to the CIRCLE variant; the pill variant (compact
    // by design) also renders on this page, so target circles explicitly.
    const control = page
      .locator('[data-testid="dose-status"][data-variant="circle"]')
      .first();
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

test.describe("long unbreakable names wrap instead of clipping (#646)", () => {
  test.use({ viewport: PHONE });

  // A slash-joined combination-drug name behaves as one long token (no space to
  // break at) — the realistic case that overflowed the medicine row.
  const NAME =
    "Hydrochlorothiazide/Lisinopril/Amlodipine/Metoprolol/Atorvastatin/Losartan";

  test("a long-token medication name stays within the 390px row", async ({
    page,
  }) => {
    await page.goto("/medicine");

    const addCard = page
      .locator("div.card")
      .filter({ hasText: "Add supplement or medication" });
    await addCard.getByLabel("Name").fill(NAME);
    await addCard.getByLabel("Amount").first().fill("1 tab");
    await addCard.getByLabel("Time of day").first().selectOption("Morning");
    await addCard.getByRole("button", { name: "Add", exact: true }).click();

    const name = page
      .getByTestId("medicine-name")
      .filter({ hasText: "Hydrochlorothiazide" })
      .first();
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
