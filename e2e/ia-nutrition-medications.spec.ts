import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { medicationList, medicationRow } from "./med-card-helpers";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";

// IA split (#746): supplements folded into the Nutrition → Supplements tab,
// medications became a standalone Medical-group page, and /medicine permanently
// redirects to the Supplements tab. This spec proves all four surfaces:
//   1. /medicine redirects to /nutrition?tab=supplements
//   2. Nutrition is a URL-driven Food | Supplements umbrella
//   3. /medications renders the medication cards + add form
//   4. an INFANT profile (Food-logging gated off) can still reach the Supplements
//      tab — infant supplements are real (vitamin D drops) — while the Food tab
//      shows the calm note.

function dbPath(): string {
  return workerDbPath();
}

test("/medicine permanently redirects to the Supplements tab (#746)", async ({
  page,
}) => {
  await page.goto("/medicine");
  await expect(page).toHaveURL(/\/nutrition\?tab=supplements/);
  // The supplement surface rendered (its situations bar), not a 404 / error page.
  await expect(page.getByTestId("situations-bar")).toBeVisible();
});

test("Nutrition is a Food | Supplements tab umbrella (#746)", async ({
  page,
}) => {
  // Default tab is Food — the serving logger.
  await page.goto("/nutrition");
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Switch to Supplements — the situations bar + supplement status render, and the
  // URL is deep-linkable. The tab is a NavTabs Next <Link>, so followLink rides
  // out the pre-hydration swallow (#889 sweep).
  await followLink(
    page,
    page.getByRole("tab", { name: "Supplements" }),
    /tab=supplements/
  );
  await expect(page.getByTestId("situations-bar")).toBeVisible();
  await expect(page.getByTestId("supplements-status")).toBeVisible();
  await expect(page.getByTestId("food-log-bar")).toHaveCount(0);

  // Creation is secondary to today's doses: the form rests closed, then opens to
  // the short name/dose/time path with advanced metadata behind its own disclosure.
  const addCard = page.getByTestId("add-supplement-card");
  await expect(addCard.getByTestId("supplement-add-panel")).toBeHidden();
  await addCard.getByTestId("supplement-add-toggle").click();
  await expect(addCard.getByTestId("supplement-add-panel")).toBeVisible();
  await expect(addCard.getByLabel("Name")).toBeVisible();
  await expect(addCard.getByLabel("Amount").first()).toBeVisible(); // first-ok: first basic dose row in the scoped add form
  await expect(
    addCard.getByTestId("supplement-more-options")
  ).not.toHaveAttribute("open", "");

  // Back to Food (NavTabs Next <Link> → followLink, #889 sweep).
  await followLink(page, page.getByRole("tab", { name: "Food" }), /tab=food/);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
});

test("the Medications page renders its list and inline add workflow (#746)", async ({
  page,
}) => {
  await page.goto("/medications");
  // The #747 parity fixture renders in the shared, scannable medication list.
  await expect(
    medicationRow(medicationList(page), "Adherence Refill Med (e2e)")
  ).toBeVisible();
  // The kind-locked add workflow opens inline instead of occupying the page at rest.
  await page.getByTestId("medication-add-toggle").click();
  await expect(page.getByTestId("medication-add-panel")).toBeVisible();
});

// ── Infant supplements reachability (#746) ───────────────────────────────────
// A profile-switch mutates SERVER-SIDE session state shared across the suite, so
// this describe runs serially and always restores the "admin" profile — the same
// discipline kids-growth.spec follows. The infant profile + its supplement are
// seeded/cleaned via a raw connection so the shared fixture is untouched.
const BABY = "Baby (e2e #746)";
const BABY_SUPP = "Baby Vitamin D (e2e #746)";

function cleanupBaby(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const ids = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .all(BABY) as { id: number }[];
    for (const { id } of ids) {
      db.prepare(
        "DELETE FROM intake_item_doses WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
      ).run(id);
      db.prepare("DELETE FROM intake_items WHERE profile_id = ?").run(id);
      db.prepare("DELETE FROM profile_settings WHERE profile_id = ?").run(id);
      // The profile row + whatever its CONSTRUCTOR seeded (the #1487 standard metric
      // saves). Deleting the row directly trips saved_items' foreign key.
      destroyFixtureProfile(db, id);
    }
  } finally {
    db.close();
  }
}

function seedBaby(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const pid = createFixtureProfile(db, BABY);
    // ~6 months old → getUserAge() = 0 → life-stage "infant" → Food logging off.
    const bd = frozenNow();
    bd.setMonth(bd.getMonth() - 6);
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)"
    ).run(pid, bd.toISOString().slice(0, 10));
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, priority, condition, source)
           VALUES (?, ?, 1, 'supplement', 'high', 'daily', 'manual')`
        )
        .run(pid, BABY_SUPP).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '400 IU', 'Morning', 'any', 0, datetime('now'))`
    ).run(itemId);
  } finally {
    db.close();
  }
}

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("user-menu-trigger").click();
  await page
    .getByTestId("user-menu-popover")
    .locator("form")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  // The ASSERTION is the settle here, and it needs a real window. This switch is
  // driven from "/" — the dashboard, the one page with steady background
  // action-POST traffic — where settledClick can resolve on a bystander poll rather
  // than the switch itself (docs/internals/e2e-hygiene.md), so the blessed form is a
  // retrying read of the server-rendered marker. The default 5s was the flake: the
  // switch POST lands, then the dashboard re-renders for the NEW profile, and under
  // suite load that re-render is what runs long — the trigger simply still showed
  // the previous profile when the clock ran out (most often on the switch BACK,
  // which left the shared session on the fixture profile for whatever ran next).
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name, {
    timeout: 20_000,
  });
}

test.describe("infant supplements stay reachable (#746)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    cleanupBaby();
    seedBaby();
  });
  test.afterAll(cleanupBaby);

  test("the Food tab is gated but the Supplements tab works", async ({
    page,
  }) => {
    await switchProfile(page, BABY);
    try {
      // Food tab: the calm infant note, no serving logger.
      await page.goto("/nutrition");
      await expect(page.getByTestId("nutrition-infant-note")).toBeVisible();
      await expect(page.getByTestId("food-log-bar")).toHaveCount(0);

      // Supplements tab: reachable, and the infant's supplement renders.
      await page.goto("/nutrition?tab=supplements");
      await expect(page.getByTestId("situations-bar")).toBeVisible();
      await expect(
        page.getByTestId("medicine-name").filter({ hasText: BABY_SUPP })
      ).toBeVisible();
    } finally {
      // Restore the default active profile for any following spec.
      await switchProfile(page, "admin");
    }
  });
});
