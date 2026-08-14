import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";

const NAME = "E2E Category Review Result";

function withDb<T>(fn: (db: Database.Database, profileId: number) => T): T {
  const db = new Database(workerDbPath());
  try {
    const profileId = (
      db.prepare("SELECT id FROM profiles ORDER BY id LIMIT 1").get() as {
        id: number;
      }
    ).id;
    return fn(db, profileId);
  } finally {
    db.close();
  }
}

function clearFixture(): void {
  withDb((db, profileId) => {
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = ? AND name = ?"
    ).run(profileId, NAME);
  });
}

test.describe("legacy clinical-result category review (#2877)", () => {
  test.beforeEach(clearFixture);
  test.afterEach(clearFixture);

  test("presents an unresolved row and applies an explicit category without moving it", async ({
    page,
  }) => {
    const id = withDb((db, profileId) =>
      Number(
        db
          .prepare(
            `INSERT INTO medical_records
               (profile_id, date, category, name, canonical_name, value, unit,
                source, external_id)
             VALUES (?, '2020-04-05', NULL, ?, ?, '7', 'points',
                     'e2e-category-review', 'e2e-category-review:1')`
          )
          .run(profileId, NAME, NAME).lastInsertRowid
      )
    );

    await page.goto("/results/clinical-results");
    const card = page.getByTestId("unclassified-results-card");
    await expect(card).toContainText(NAME);
    await expect(card).toContainText("Allos won’t guess");

    await card.getByRole("combobox", { name: "Category" }).selectOption("lab");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card).toHaveCount(0);

    expect(
      withDb((db) =>
        db
          .prepare(
            `SELECT id, category, name, canonical_name, value, unit, source,
                    external_id, edited
               FROM medical_records WHERE id = ?`
          )
          .get(id)
      )
    ).toEqual({
      id,
      category: "lab",
      name: NAME,
      canonical_name: NAME,
      value: "7",
      unit: "points",
      source: "e2e-category-review",
      external_id: "e2e-category-review:1",
      edited: 1,
    });
  });
});
