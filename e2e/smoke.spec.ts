import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { followLink, openCommandPalette } from "./nav";

// Clear the coaching "Not today" snooze so the #39 test starts UNSNOOZED on every
// repeat (#868 fixture ownership). `snoozeCoaching` writes a persistent
// upcoming_dismissals row keyed by the coaching finding's dedupeKey; without this
// reset a second --repeat-each run finds the top recommendation already snoozed and
// the coaching card gone, failing the "card visible" assertion. Scoped to the
// admin's active profile 1 and the coaching namespace. Short-lived connection +
// busy timeout so it never contends with the running server on the WAL DB.
function resetCoachingSnooze(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = 1 AND signal_key LIKE 'coaching:%'"
    ).run();
  } finally {
    db.close();
  }
}

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
  "/results",
  "/nutrition",
  "/medications",
  "/settings",
];

// #181: with ALLOS_DEMO_MODE unset (the default webServer env), demo mode is fully
// inert — the persistent demo banner must be absent on both the login page and an
// authenticated page, and the login page shows no demo-credentials card. The
// present-in-demo-mode assertions live in demo.spec.ts (its own demo webServer).
test("no demo banner or credentials by default (#181)", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByTestId("demo-banner")).toHaveCount(0);
  await expect(page.getByTestId("demo-credentials")).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByTestId("demo-banner")).toHaveCount(0);
});

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
  // Own the fixture (#868): start unsnoozed so the card is present on every repeat.
  resetCoachingSnooze();
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
  await page.goto("/results?q=non-hdl");
  // The derived index renders its Derived badge.
  await expect(page.getByTestId("derived-badge").first()).toBeVisible();

  // Non-HDL Cholesterol is derived from the seeded Total + HDL readings.
  const link = page.getByRole("link", { name: "Non-HDL Cholesterol" }).first();
  await followLink(page, link, /\/biomarkers\/view/);

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
  await page.goto("/results?q=phenoage");
  // Renders with the shared "Derived" badge.
  await expect(page.getByTestId("derived-badge").first()).toBeVisible();

  const link = page.getByRole("link", { name: "PhenoAge" }).first();
  await followLink(page, link, /\/biomarkers\/view/);

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
  await page.goto("/results");
  const hero = page.getByRole("main").getByTestId("bio-age-hero");
  await expect(hero).toBeVisible();
  // The headline number and its delta to chronological age.
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();
  await expect(hero.getByTestId("bio-age-delta")).toContainText("calendar age");
  // Estimate framing with the model citation (never a precise verdict).
  const estimate = hero.getByTestId("bio-age-estimate");
  await expect(estimate).toContainText("estimate");
  await expect(estimate).toContainText("Levine PhenoAge");
  await expect(estimate).toContainText("not a precise verdict");
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
    await page.goto("/results");
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
  // Open via Ctrl-K (the handler accepts metaKey||ctrlKey); openCommandPalette
  // re-presses until the palette is up, since a pre-hydration keypress is
  // swallowed under parallel-run contention (issue #500).
  const input = await openCommandPalette(page);
  await input.fill("penicillin");
  // The result list is the palette's listbox; scope to it so the sidebar's own
  // "Allergies" nav link can't satisfy the assertions.
  const results = page.getByRole("listbox", { name: "Results" });
  await expect(results.getByText("Allergies", { exact: true })).toBeVisible();
  const hit = results.getByRole("option", { name: /Penicillin/i });
  // Selecting it navigates to the allergies passport page.
  await followLink(page, hit.first(), /\/records#allergies$/);
  await expect(page).toHaveURL(/\/records#allergies$/);
});

// #38: a refill-tracked supplement (seed sets Magnesium Glycinate's on-hand
// supply) shows an "≈N days left" estimate that names its basis — the actual
// taken-log rate vs the scheduled-dose-count fallback. Asserts the rendered
// days-left badge carries both the days text and the basis label.
test("supplements page shows a refill days-left estimate with its basis (#38)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  const badge = page.getByTestId("refill-days-left").first();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);
});

// #272: a medication whose name carries a PERCENT strength ("Hydrocortisone
// 2.5% Cream", seeded in e2e/seed-events.ts) must still resolve its educational
// "What is this?" explainer — the dead `%\b` regex never stripped percent
// strengths, so every topical/cream/drop silently lost its description. In the
// #817 redesign the explainer lives on the /medications/[id] detail page (the med's
// clinical-record home), reached from its list row.
test("percent-strength medication resolves its 'What is this?' explainer (#272)", async ({
  page,
}) => {
  await page.goto("/medications");
  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: "Hydrocortisone 2.5% Cream" })
    .first()
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  const detail = page.getByTestId("medication-detail");
  // Navigate past the pre-hydration swallow (#730/#500) with the blessed followLink
  // (#868) instead of a hand-rolled click-until-detail-shows toPass loop.
  await followLink(page, link, /\/medications\/\d+/);
  await expect(detail).toBeVisible();
  // Generic + drug class from lib/medication-descriptions.json — only rendered
  // when the normalized lookup lands on the hydrocortisone entry. The redesigned
  // detail page keeps this information visible under "About this medication".
  await expect(
    detail.getByText("About this medication", { exact: true })
  ).toBeVisible();
  await expect(detail).toContainText("Corticosteroid");
  await expect(detail).toContainText(
    /corticosteroid used to reduce inflammation/i
  );
});
