import { test, expect, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick } from "./helpers";
import { followLink, openCommandPalette } from "./nav";
import { openMedDetailViaLink, refillBadge } from "./med-card-helpers";

// Clear the coaching "Snooze" snooze so the #39 test starts UNSNOOZED on every
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
  "/sleep",
  "/upcoming",
  "/data",
  "/results",
  "/nutrition",
  "/medications",
  "/settings",
];

// The app shell renders ONE of two navigation surfaces depending on viewport, so
// the "this is the app, not a Next error boundary" anchor has to follow suit
// (issue #1420 — this spec now runs in the `mobile` project too): the desktop
// sidebar is `hidden md:flex` (app/(app)/layout.tsx) and MobileNav's top bar is
// `md:hidden`, and the drawer holding the sidebar's links isn't even mounted
// until the hamburger is tapped. Below the Tailwind `md` breakpoint (768px) the
// anchor is that hamburger; at desktop widths it stays the sidebar's Data link
// (exact:true avoids the Import tab's provider links that also contain "Data").
function appShellAnchor(page: Page): Locator {
  const width = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY;
  return width < 768
    ? page.getByRole("button", { name: "Open menu" })
    : page.getByRole("link", { name: "Data", exact: true });
}

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
    // The viewport's navigation surface proves the app shell rendered rather
    // than a Next error boundary / 500 page (see appShellAnchor).
    await expect(appShellAnchor(page)).toBeVisible();
    await expect(page.getByText("Application error")).toHaveCount(0);
  });
}

// #39 (findings bus): the dashboard Coaching widget's "Snooze" snoozes the top
// recommendation through the shared suppression store, so it's no longer the
// widget's top suggestion after the click (the next-ranked one surfaces, or the
// empty fallback shows). Exercises a coaching Recommendation → Finding adapter, the
// generalized snoozeFinding writer, and the round-trip re-render end-to-end.
test("dashboard coaching 'Snooze' snoozes the top recommendation (#39)", async ({
  page,
}) => {
  // Own the fixture (#868): start unsnoozed so the card is present on every repeat.
  resetCoachingSnooze();
  await page.goto("/");
  const card = page.locator(".card", {
    has: page.getByTestId("coaching-snooze"),
  });
  await expect(card).toBeVisible();
  const original = (await card.locator("p.font-semibold").first().textContent()) // first-ok: the scoped coaching card's title text — order-agnostic
    ?.trim();
  expect(original).toBeTruthy();

  // settledClick, not a bare .click() (#1513): Snooze submits a Server Action, and a
  // tap that lands before the form hydrates is swallowed — the POST never happens and
  // the assertion below then reads a state that never changed. Measured 3-of-4 locally
  // under isolation; the #1400/#1464 class, caught latent rather than in CI.
  await settledClick(page, card.getByTestId("coaching-snooze"));
  // settledClick arms a same-origin POST wait, which the app-wide toaster polls can
  // satisfy instead of this action's own request (#1437) — so hold on the action's OWN
  // durable completion marker before reading the result: SubmitButton renders its
  // `pendingLabel` ("…") for exactly as long as the transition is pending, and a
  // bystander poll cannot fake that. It resolves whether the widget re-renders with
  // the next recommendation or falls back to empty (the card locator then matches
  // nothing, which is a count of 0 either way).
  await expect(card.getByText("…", { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  // The snoozed recommendation is no longer shown as the widget's suggestion. The
  // dashboard is the app's heaviest server render, so the revalidated-RSC hand-off
  // gets the heavy-page budget too (the #1306 class) rather than the default 5s.
  await expect(card.getByText(original!, { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
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
  await expect(page.getByTestId("derived-badge").first()).toBeVisible(); // first-ok: asserts a Derived badge renders — order-agnostic presence
  // Non-HDL Cholesterol is derived from the seeded Total + HDL readings.
  const link = page.getByRole("link", { name: "Non-HDL Cholesterol" }).first(); // first-ok: the seeded Non-HDL Cholesterol result link — order-agnostic
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
  await expect(page.getByTestId("derived-badge").first()).toBeVisible(); // first-ok: asserts a Derived badge renders — order-agnostic presence

  const link = page.getByRole("link", { name: "PhenoAge" }).first(); // first-ok: the seeded PhenoAge result link — order-agnostic
  await followLink(page, link, /\/biomarkers\/view/);

  const note = page.getByTestId("derived-note");
  // The biomarkers/view page derives PhenoAge (Levine 2018) from the nine-analyte panel
  // at read time — a first-visit compute burst that a degraded whole-suite single-worker
  // runner can push past the default 5s (#1306). Give the first render the heavy-page
  // budget; the follow-up content asserts inherit the now-rendered note.
  await expect(note).toBeVisible({ timeout: 15_000 });
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
    // Same class as the Snooze above (#1513): the chip is a Server-Action form submit
    // whose RESULT this asserts, so wait for the action's POST rather than assuming a
    // pre-hydration tap landed.
    await settledClick(
      page,
      page.getByRole("main").getByTestId("household-chip-2")
    );
    // The switch's own completion marker, on the heavy-page budget (#1306): the chip
    // posts openProfileAction and redirects back to the dashboard, and settledClick's
    // same-origin POST wait can be satisfied by an app-wide toaster poll instead of
    // that action (#1437) — so the switch can still be in flight when this reads. The
    // retry IS the wait; it just needs longer than the default 5s on the app's
    // heaviest server render.
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)",
      { timeout: 15_000 }
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
// link to the Allergies pane. Since #1449 that is the LEAF pane
// (/records/problems/allergies), not the old stacked Problems route — the hit lands
// ON the allergy list instead of above a stack. Proves the search domains wire
// end-to-end (query → server
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
  // Selecting it navigates to Problems › Allergies, the pane that owns the record.
  await followLink(page, hit.first(), /\/records\/problems\/allergies$/); // first-ok: the command-palette Penicillin allergy result — order-agnostic
  await expect(page).toHaveURL(/\/records\/problems\/allergies$/);
});

// #38: a refill-tracked supplement (seed sets Magnesium Glycinate's on-hand
// supply) shows an "≈N days left" estimate that names its basis — the actual
// taken-log rate vs the scheduled-dose-count fallback. Asserts the rendered
// days-left badge carries both the days text and the basis label.
test("supplements page shows a refill days-left estimate with its basis (#38)", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  // The supplements list is a shared surface, so take the first refill badge (whichever
  // supplement leads); the `refill-days-left` anatomy is owned by the shared med-card
  // driver (#868 class-2). The assertions below stay in the spec.
  const badge = refillBadge(page).first(); // first-ok: shared list — asserts the days-left FORMAT on whichever refill badge leads (see comment above), not a specific supplement
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
  // Navigate past the pre-hydration swallow (#730/#500) with the shared med-card driver's
  // followLink-based row→detail nav (#868 class-2) instead of a hand-rolled click loop.
  const detail = await openMedDetailViaLink(page, "Hydrocortisone 2.5% Cream");
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
