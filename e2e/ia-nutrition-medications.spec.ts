import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

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
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
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
  // URL is deep-linkable.
  await page.getByRole("tab", { name: "Supplements" }).click();
  await expect(page).toHaveURL(/tab=supplements/);
  await expect(page.getByTestId("situations-bar")).toBeVisible();
  await expect(page.getByTestId("supplements-status")).toBeVisible();
  await expect(page.getByTestId("food-log-bar")).toHaveCount(0);

  // Back to Food.
  await page.getByRole("tab", { name: "Food" }).click();
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
});

test("the Medications page renders its cards and add form (#746)", async ({
  page,
}) => {
  await page.goto("/medications");
  // The #747 parity fixture med card renders here now.
  await expect(
    page
      .locator("div.card")
      .filter({ hasText: "Adherence Refill Med (e2e)" })
      .first()
  ).toBeVisible();
  // The kind-locked medication add form.
  await expect(
    page.getByRole("heading", { name: "Add medication" })
  ).toBeVisible();
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
      db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
    }
  } finally {
    db.close();
  }
}

function seedBaby(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const pid = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(BABY)
        .lastInsertRowid
    );
    // ~6 months old → getUserAge() = 0 → life-stage "infant" → Food logging off.
    const bd = new Date();
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
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
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
