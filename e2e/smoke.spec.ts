import { test, expect } from "@playwright/test";

// Broad smoke coverage: each primary authenticated surface renders (real HTTP
// 200 + the app shell, not a Next error page) against the seeded DB. Catches
// server-component crashes / bad queries that a build alone won't.
const ROUTES = [
  "/", // dashboard
  "/training",
  "/trends",
  "/timeline",
  "/upcoming",
  "/data",
  "/biomarkers",
  "/medicine",
  "/settings",
];

for (const route of ROUTES) {
  test(`renders ${route}`, async ({ page }) => {
    const resp = await page.goto(route);
    expect(resp?.status(), `HTTP status for ${route}`).toBeLessThan(400);
    // The shared sidebar (Data nav link) proves the app shell rendered rather
    // than a Next error boundary / 500 page. exact:true avoids matching the
    // Import tab's provider links that also contain "Data".
    await expect(
      page.getByRole("link", { name: "Data", exact: true })
    ).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
  });
}

// #39 (findings bus): the dashboard Coaching widget's "Not today" snoozes the top
// recommendation through the shared suppression store, so it's no longer the
// widget's top suggestion after the click (the next-ranked one surfaces, or the
// empty fallback shows). Exercises a coaching Recommendation → Finding adapter, the
// generalized snoozeFinding writer, and the round-trip re-render end-to-end.
test("dashboard coaching 'Not today' snoozes the top recommendation (#39)", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.locator(".card", {
    has: page.getByTestId("coaching-not-today"),
  });
  await expect(card).toBeVisible();
  const original = (
    await card.locator("p.font-semibold").first().textContent()
  )?.trim();
  expect(original).toBeTruthy();

  await card.getByTestId("coaching-not-today").click();
  // The snoozed recommendation is no longer shown as the widget's suggestion.
  await expect(card.getByText(original!, { exact: true })).toHaveCount(0);
});

// #40: derived clinical indices are computed at read time from the seeded lipid /
// metabolic / kidney panels and surfaced on the Biomarkers page like normal
// analytes — Non-HDL Cholesterol (Total − HDL) appears with a "Derived" badge, and
// its detail page explains the derivation instead of a source document.
test("biomarkers page surfaces a derived clinical index (#40)", async ({
  page,
}) => {
  // Filter to the analyte via the server-side ?q= search: the table now ships
  // one bounded page (#114), so on an unfiltered view the derived rows can land
  // beyond page 1 for a long history — the filter keeps this assertion about
  // "derived indices render", not about pagination order.
  await page.goto("/biomarkers?q=non-hdl");
  // The derived index renders its Derived badge.
  await expect(page.getByTestId("derived-badge").first()).toBeVisible();

  // Non-HDL Cholesterol is derived from the seeded Total + HDL readings.
  const link = page.getByRole("link", { name: "Non-HDL Cholesterol" }).first();
  await expect(link).toBeVisible();
  await link.click();

  const note = page.getByTestId("derived-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Derived index");
  await expect(note).toContainText("Total Cholesterol − HDL");
});

// #157: PhenoAge (Levine 2018) is a derived biological-age index computed at read
// time from the seeded nine-analyte panel (albumin, creatinine, glucose, hs-CRP,
// lymphocyte %, MCV, RDW, ALP, WBC) + the adult profile's age. It surfaces on the
// Biomarkers page like any other derived analyte, and its detail page explains the
// derivation and cites the formula.
test("biomarkers page surfaces the derived PhenoAge biological age (#157)", async ({
  page,
}) => {
  await page.goto("/biomarkers?q=phenoage");
  // Renders with the shared "Derived" badge.
  await expect(page.getByTestId("derived-badge").first()).toBeVisible();

  const link = page.getByRole("link", { name: "PhenoAge" }).first();
  await expect(link).toBeVisible();
  await link.click();

  const note = page.getByTestId("derived-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Derived index");
  await expect(note).toContainText("Levine PhenoAge");
});

// #209: PhenoAge is surfaced as a headline biological-age HERO card pinned above the
// Biomarkers table (not just the derived row). For the seeded ADULT profile (a full
// nine-analyte panel + a known age) the card shows the biological age, its delta to
// calendar age, and the required estimate citation. Read-only — no mutation.
test("biomarkers page shows the biological-age hero for the adult (#209)", async ({
  page,
}) => {
  await page.goto("/biomarkers");
  const hero = page.getByRole("main").getByTestId("bio-age-hero");
  await expect(hero).toBeVisible();
  // The headline number and its delta to chronological age.
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();
  await expect(hero.getByTestId("bio-age-delta")).toContainText("calendar age");
  // Estimate framing with the model citation (never a precise verdict).
  const estimate = hero.getByTestId("bio-age-estimate");
  await expect(estimate).toContainText("Estimate");
  await expect(estimate).toContainText("Levine PhenoAge");
});

// #209: the hero is ADULT-GATED exactly as the computation is — hidden entirely for a
// child profile (PhenoAge is an adult population model). Switches to profile 2,
// "Riley (child)", in an ISOLATED cookie-less context with its own fresh session, so
// it never disturbs the shared admin session other specs depend on.
test("biological-age hero is absent for a child profile (#209)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  try {
    await page.goto("/login");
    await page.fill('input[name="username"]', "admin");
    await page.fill('input[name="password"]', "e2e-admin-pass");
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 20_000,
    });

    // Switch to profile 2 ("Riley (child)") via its household chip, then confirm the
    // switch by the user-menu naming the new profile.
    await page.goto("/");
    await page.getByRole("main").getByTestId("household-chip-2").click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    // On the child's Biomarkers page the hero is not rendered at all.
    await page.goto("/biomarkers");
    await expect(
      page.getByRole("main").getByTestId("bio-age-hero")
    ).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

// #19: the global (Cmd-K) command palette now fans out over the clinical passport,
// so an allergy substance is findable. Seed documents a Penicillin allergy; opening
// the palette and typing "penicillin" must surface it under the Allergies group and
// link to /allergies. Proves the new search domains wire end-to-end (query → server
// action → ranked group → rendered hit).
test("command palette surfaces a seeded allergy for 'penicillin' (#19)", async ({
  page,
}) => {
  await page.goto("/");
  // Open via Ctrl-K (the handler accepts metaKey||ctrlKey).
  await page.keyboard.press("Control+KeyK");
  const input = page.getByRole("combobox", { name: "Search or run a command" });
  await expect(input).toBeVisible();
  await input.fill("penicillin");
  // The result list is the palette's listbox; scope to it so the sidebar's own
  // "Allergies" nav link can't satisfy the assertions.
  const results = page.getByRole("listbox", { name: "Results" });
  await expect(results.getByText("Allergies", { exact: true })).toBeVisible();
  const hit = results.getByRole("option", { name: /Penicillin/i });
  await expect(hit.first()).toBeVisible();
  // Selecting it navigates to the allergies passport page.
  await hit.first().click();
  await expect(page).toHaveURL(/\/allergies$/);
});

// #38: a refill-tracked supplement (seed sets Magnesium Glycinate's on-hand
// supply) shows an "≈N days left" estimate that names its basis — the actual
// taken-log rate vs the scheduled-dose-count fallback. Asserts the rendered
// days-left badge carries both the days text and the basis label.
test("supplements page shows a refill days-left estimate with its basis (#38)", async ({
  page,
}) => {
  await page.goto("/medicine");
  const badge = page.getByTestId("refill-days-left").first();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);
});
