import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Unit-mislabel cross-check on Data → Review (issue #761): a numeric lab reading
// whose stored unit is a probable power-of-ten mislabel of the canonical unit
// (MCHC "33 g/L" whose printed range 31–37 is really g/dL) surfaces a one-click
// correction card. Apply corrects the unit (before/after shown) and the card clears;
// Dismiss records a false positive and the card clears.
//
// Fixture discipline (shared seeded DB): this spec owns its OWN rows — MCHC readings
// stamped with a unique panel marker on profile 1 — seeded via a raw connection and
// cleaned in beforeAll AND afterAll (idempotent across retries, never touches seeded
// rows). Every locator is scoped to the specific card by its record id, never
// a positional first-match on the shared Review surface.

const MARKER = "E2E-MISLABEL-761";

let applyId = 0;
let dismissId = 0;

function dbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

function cleanup(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const ids = db
      .prepare("SELECT id FROM medical_records WHERE panel = ?")
      .all(MARKER) as { id: number }[];
    for (const { id } of ids) {
      db.prepare("DELETE FROM upcoming_dismissals WHERE signal_key = ?").run(
        `unit-mislabel:${id}`
      );
    }
    db.prepare("DELETE FROM medical_records WHERE panel = ?").run(MARKER);
  } finally {
    db.close();
  }
}

function seedMislabel(db: Database.Database): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, panel, value, unit, canonical_name, value_num, reference_range, flag)
         VALUES (1, '2099-02-01', 'lab', 'MCHC', ?, '33', 'g/L', 'MCHC', 33, '31-37', NULL)`
      )
      .run(MARKER).lastInsertRowid
  );
}

function unitOf(id: number): string | null {
  const db = new Database(dbPath());
  try {
    const r = db
      .prepare("SELECT unit FROM medical_records WHERE id = ?")
      .get(id) as { unit: string | null } | undefined;
    return r?.unit ?? null;
  } finally {
    db.close();
  }
}

test.describe("Data → Review unit-mislabel correction (#761)", () => {
  test.beforeAll(() => {
    cleanup();
    const db = new Database(dbPath());
    try {
      db.pragma("busy_timeout = 5000");
      applyId = seedMislabel(db);
      dismissId = seedMislabel(db);
    } finally {
      db.close();
    }
  });
  test.afterAll(cleanup);

  test("shows the mislabel card and Apply corrects the unit (before/after shown)", async ({
    page,
  }) => {
    await page.goto("/data?section=review");
    const card = page.locator(
      `[data-testid="unit-mislabel-card"][data-record-id="${applyId}"]`
    );
    await expect(card).toBeVisible();

    // The card explains the correction and shows the explicit before → after.
    await expect(card).toContainText("matches g/dL, not g/L");
    const beforeAfter = card.getByTestId("unit-mislabel-beforeafter");
    await expect(beforeAfter).toContainText("33 g/L");
    await expect(beforeAfter).toContainText("33 g/dL");

    // Apply the correction — the card clears (a swallowed click in the hydration
    // window leaves the card; retry until the row is gone).
    const apply = card.getByTestId("unit-mislabel-apply");
    await expect(async () => {
      if (await card.isVisible()) await apply.click({ timeout: 2000 });
      await expect(card).toHaveCount(0, { timeout: 3000 });
    }).toPass({ timeout: 20_000 });

    // The stored unit is now the canonical g/dL — the false flag is gone at the source.
    expect(unitOf(applyId)).toBe("g/dL");
  });

  test("Dismiss removes the card as a false positive", async ({ page }) => {
    await page.goto("/data?section=review");
    const card = page.locator(
      `[data-testid="unit-mislabel-card"][data-record-id="${dismissId}"]`
    );
    await expect(card).toBeVisible();

    const dismiss = card.getByTestId("unit-mislabel-dismiss");
    await expect(async () => {
      if (await card.isVisible()) await dismiss.click({ timeout: 2000 });
      await expect(card).toHaveCount(0, { timeout: 3000 });
    }).toPass({ timeout: 20_000 });

    // Dismiss suppresses the detection but never mutates the reading's unit.
    expect(unitOf(dismissId)).toBe("g/L");

    // It stays gone on reload (recorded in the suppression bus).
    await page.reload();
    await expect(card).toHaveCount(0);
  });
});
