import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

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
  return workerDbPath();
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

// PUT THE FIXTURE'S UNIT BACK (#5266). The Apply test corrects `unit` IN PLACE on a
// row this file seeded on the SHARED profile, so the correction reads as one row
// removed and one added there. Both are this file's own rows and it still deletes
// them in `afterAll`; what the per-test guard is entitled to see is a test that ends
// its own row the way it found it.
//
// Restoring the seeded unit is also what lets the Apply test run a SECOND time at
// all: `beforeAll` seeds once per worker, and the card only renders while the
// mislabel is still there, so a `--repeat-each` iteration used to find a corrected
// row and no card.
//
// Addressed by the MARKER, never by id, so it is idempotent across retries and
// touches nothing the seed owns.
function restoreSeededUnits(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "UPDATE medical_records SET unit = 'g/L' WHERE panel = ? AND unit <> 'g/L'"
    ).run(MARKER);
  } finally {
    db.close();
  }
}

// A DATE OUTSIDE THE SHARED-PROFILE WATCH (#5266). `beforeAll` seeds once per worker
// and `afterAll` clears it, so these two rows exist across every test in this file —
// and both hooks run in the window BETWEEN two tests, where the gap diff can see them
// and can only charge them to this file's `beforeAll`. Dating them in the deep past
// puts them outside the watched bound (`medical_records` is watched from today
// onward) the way every other file-owned fixture on profile 1 already does, so the
// rows are invisible to a guard that has nothing to say about them. Nothing here
// reads the date: `getUnitMislabelReviews` filters on unit and reference range only,
// and every locator below addresses its card by record id.
function seedMislabel(db: Database.Database): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, panel, value, unit, canonical_name, value_num, reference_range, flag)
         VALUES (1, '2019-02-01', 'lab', 'MCHC', ?, '33', 'g/L', 'MCHC', 33, '31-37', NULL)`
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
  test.afterEach(restoreSeededUnits);
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
    // eslint-disable-next-line no-restricted-properties -- topass-ok: re-click Apply until the card clears past the hydration swallow — no single re-click+await event for the client-cleared row
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
    // eslint-disable-next-line no-restricted-properties -- topass-ok: re-click Dismiss until the card clears past the hydration swallow — no single re-click+await event
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
