import { test, expect } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";

// Preventive visits/screenings in Upcoming (issues #82 + #86). The seeded
// profile 1 is a ~40-year-old with a birthdate (scripts/seed.ts), so the pure
// catalog assessor surfaces due/overdue preventive items — but record-driven
// inference (#86) now also runs against the SAME seeded fixture, so these specs
// must target rules the seed CANNOT infer-satisfy:
//   • "Dental check-up & cleaning" (visit) — no dental appointment/encounter/
//     procedure is seeded.
//   • "Hepatitis C screening" (screening) — no HCV test is seeded (the hepatitis
//     B titer does not match the hep C concept map).
// Both stay in their catalog windows for decades of profile-1 aging and the seed
// is fully relative-dated, so the specs are deterministic year-round.
//
// The rules the OLD (#82-era) specs used are now load-bearing inference cases:
// the completed "Annual physical" appointment satisfies the adult check-up, and
// the recent blood-pressure readings satisfy the BP screening — pinned below.
//
// These specs prove, end-to-end, that:
//   1. a due preventive item renders on /upcoming with the general-guidelines
//      disclaimer,
//   2. "Mark done" records a satisfaction and clears the item,
//   3. the "Not applicable" override hides a different item,
//   4. a rule already satisfied by seeded records does NOT render (inference),
//   5. the "Book" CTA (issue #85) opens the appointment form prefilled with the
//      item's title + kind, and once that visit is scheduled the item quiets to a
//      "Scheduled" state instead of nagging.
// The default specs run authenticated as admin acting as profile 1 (storageState).
//
// ── Isolation (issue #206) ─────────────────────────────────────────────────
// Two defects made this spec a source of false-red CI on unrelated PRs:
//
//   (1) Strict-mode double-match. The item locators used the un-scoped
//       `page.getByTestId(...)`. The authenticated app shell (app/(app)/layout.tsx)
//       renders the page inside a single <main>, but a hidden copy of the item
//       resolves outside <main>, so once the booked item drops into the quiet
//       "Scheduled"/Later band the plain testid matched TWO elements and
//       `toBeVisible()` threw a strict-mode violation. Every upcoming-item locator
//       below is now scoped to `page.getByRole("main")`, which pins the assertion
//       to the visible list container and cannot match the shell copy.
//
//   (2) Serial-retry pollution. This is a serial group (see below) that mutates
//       the SHARED, seed-once e2e DB: the mark-done test records a preventive
//       satisfaction, the override test records an override, and the booking test
//       creates a "Skin check" appointment — none reversible through the browser
//       (there is no UI to clear a recorded satisfaction/override). Left behind,
//       any Playwright retry of the serial block re-ran the earlier tests against
//       already-mutated state ("element not found"). `resetPreventiveFixture()`
//       below returns the three tables these tests touch to their seeded-empty
//       state directly on the isolated e2e DB (mirroring how e2e/seed-events.ts
//       manages e2e fixtures at the DB layer), run in BOTH beforeAll and afterAll
//       so every attempt — including a whole-group retry — starts from a clean,
//       seed-equivalent state and leaves the shared DB pristine for other specs.
//       A DB-level beforeAll reset is strictly more robust than a mid-test UI
//       teardown: it guarantees a clean entry even if a prior attempt's teardown
//       itself failed.

const VISIT_KEY = "upcoming-item-visit:dental_cleaning";
const SCREENING_KEY = "upcoming-item-screening:hepatitis_c";

// The baked USPSTF depression screening (issue #149): due for the seeded ~40yo,
// not infer-satisfied by any seeded record, and used by NO other spec, so
// overriding it can't disturb the mark-done (dental) / override (hepatitis C) /
// booking (skin) specs. Its override is cleared by resetPreventiveFixture.
const DEPRESSION_KEY = "upcoming-item-screening:depression_screening";

// Rules the seeded records infer-satisfy (issue #86) — must NOT render.
const INFERRED_VISIT_KEY = "upcoming-item-visit:adult_physical";
const INFERRED_SCREENING_KEY = "upcoming-item-screening:blood_pressure";

// The "Skin check" visit (issue #85 booking flow): due for the seeded ~40yo, not
// infer-satisfied by any seeded record, and used by NO other spec, so booking it
// can't disturb the mark-done (dental) / override (hepatitis C) specs. Its mapped
// appointment kind is the generic `screening`. Serial mode + running this booking
// spec LAST keeps that coarse `screening` bucket from touching the override spec's
// hepatitis-C row (already removed by the time this runs).
const SKIN_KEY = "upcoming-item-visit:skin_check";

const PROFILE_ID = 1;

// Reset the preventive/appointment state these tests mutate back to its
// seeded-empty baseline, directly on the isolated e2e SQLite file. The app and
// this helper resolve the SAME database — the webServer boots against
// ALLOS_DB_PATH, defaulting to e2e/.data/e2e.db (see playwright.config.ts) — and
// the seed creates none of these rows, so removing them wholesale is safe and
// returns the DB to its seeded state. Opened on its own short-lived connection
// with a busy timeout so it never contends with the running server (WAL).
function resetPreventiveFixture(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare("DELETE FROM preventive_events WHERE profile_id = ?").run(
      PROFILE_ID
    );
    db.prepare("DELETE FROM preventive_overrides WHERE profile_id = ?").run(
      PROFILE_ID
    );
    // The only appointment these tests create is the booked "Skin check"
    // screening visit; the seed ships none, so this clears exactly the test's row.
    db.prepare(
      "DELETE FROM appointments WHERE profile_id = ? AND title = 'Skin check' AND status = 'scheduled'"
    ).run(PROFILE_ID);
  } finally {
    db.close();
  }
}

test.describe.configure({ mode: "serial" });

test.describe("preventive care in Upcoming (issues #82 + #86 + #85)", () => {
  // Clean entry for every attempt (incl. a serial-group retry) and a pristine
  // exit for the other specs sharing the seed-once DB.
  test.beforeAll(resetPreventiveFixture);
  test.afterAll(resetPreventiveFixture);

  test("rules satisfied by existing records are inferred done and stay hidden", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    // Anchor on a rendered preventive row first so the absence assertions below
    // check a fully-loaded list, not an unrendered page. The eye-exam visit is
    // used because no seeded record can satisfy it AND no other spec mutates it
    // (tests in this file may run in parallel workers locally).
    await expect(
      main.getByTestId("upcoming-item-visit:vision_exam")
    ).toBeVisible();

    // The seeded completed "Annual physical" appointment (~35 days ago) satisfies
    // the adult check-up; the seeded blood-pressure readings (~30 days ago)
    // satisfy the BP screening — neither needs a manual mark-done.
    await expect(main.getByTestId(INFERRED_VISIT_KEY)).toHaveCount(0);
    await expect(main.getByTestId(INFERRED_SCREENING_KEY)).toHaveCount(0);

    // The baked USPSTF depression screening (issue #149) surfaces for the seeded
    // ~40yo — no PHQ/depression record is seeded, so it stays actionable and
    // renders end-to-end from lib/screenings.json through the shared engine.
    await expect(main.getByTestId(DEPRESSION_KEY)).toBeVisible();
  });

  test("a screening item links to a real satisfying surface, never the removed /medical (issue #283)", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    // The depression screening is procedure-coded in the concept map, so its
    // satisfaction-derived link is the procedures surface. Read-only (a click),
    // so it runs BEFORE the later test in this serial group declines the rule.
    const depression = main.getByTestId(DEPRESSION_KEY);
    await expect(depression).toBeVisible();
    await depression
      .getByRole("link", { name: "Depression screening", exact: true })
      .click();

    await expect(page).toHaveURL(/\/procedures/);
    await expect(
      page.getByRole("main").getByText("Procedures").first()
    ).toBeVisible();
  });

  test("a due preventive visit shows the disclaimer, marks done, and clears", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const visit = main.getByTestId(VISIT_KEY);
    await expect(visit).toBeVisible();
    await expect(visit).toContainText("Dental check-up & cleaning");

    // The informational disclaimer is present whenever preventive items show.
    await expect(main.getByText("your provider's advice wins")).toBeVisible();

    // Mark it done → the satisfaction advances the next-due out of the window and
    // the row drops off the list on revalidate.
    await visit.getByRole("button", { name: "Mark done" }).click();
    await expect(main.getByTestId(VISIT_KEY)).toHaveCount(0);
  });

  test("the Not applicable override hides a preventive screening", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const screening = main.getByTestId(SCREENING_KEY);
    await expect(screening).toBeVisible();

    // Open the row's override menu (the shared OverflowMenu popover, portaled to
    // <body> — #281) and choose "Not applicable" from the page-level menu.
    await screening.getByLabel("Not applicable or declined").click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Not applicable" })
      .click();

    await expect(main.getByTestId(SCREENING_KEY)).toHaveCount(0);
  });

  test("a baked USPSTF depression screening surfaces and can be declined (issue #149)", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const depression = main.getByTestId(DEPRESSION_KEY);
    await expect(depression).toBeVisible();
    await expect(depression).toContainText("Depression screening");

    // Declining it (the override affordance) hides it and it stays hidden. The
    // menu panel is portaled to <body> (#281), so locate it page-level.
    await depression.getByLabel("Not applicable or declined").click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Declined" })
      .click();

    await expect(main.getByTestId(DEPRESSION_KEY)).toHaveCount(0);
  });

  test("the Book CTA prefills the appointment form and booking quiets the item to Scheduled (issue #85)", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/upcoming");
    const main = page.getByRole("main");

    const skin = main.getByTestId(SKIN_KEY);
    await expect(skin).toBeVisible();

    // Follow the row's "Book" CTA to the appointment form.
    await skin.getByRole("link", { name: "Book" }).click();
    await expect(page).toHaveURL(/\/appointments/);

    // The create form is prefilled from the preventive item: its title and the
    // rule's mapped visit kind (skin check → screening).
    await expect(page.getByLabel("Reason / title")).toHaveValue("Skin check");
    await expect(page.getByLabel("Kind (optional)")).toHaveValue("screening");

    // Save the (still-scheduled) visit — the date is prefilled to the suggested day.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Back on Upcoming, the matching-kind booking quiets the preventive item to a
    // non-nagging "Scheduled" state (still visible, not hidden).
    await page.goto("/upcoming");
    const scheduledSkin = main.getByTestId(SKIN_KEY);
    await expect(scheduledSkin).toBeVisible();
    await expect(scheduledSkin).toContainText("Scheduled");
  });
});
