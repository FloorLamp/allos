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
  await page.goto("/biomarkers");
  // At least one derived index (Non-HDL, TG/HDL, eGFR) renders its Derived badge.
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
  const input = page.getByRole("combobox", { name: "Search all data" });
  await expect(input).toBeVisible();
  await input.fill("penicillin");
  // The result list is the palette's listbox; scope to it so the sidebar's own
  // "Allergies" nav link can't satisfy the assertions.
  const results = page.getByRole("listbox", { name: "Search results" });
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
