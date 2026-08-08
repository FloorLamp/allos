import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";

// RECORDS-RECENCY asks on /upcoming (#2164 + #2176).
//
// Both legs are pure functions of a DATA FRONTIER, so the fixture is exactly that:
//
//   #2164 — a handful of `fitbit-takeout` rows on the archive-exclusive streams, dated
//           well past the registry's declared horizon. The seed ships none, so these
//           rows are entirely spec-owned.
//   #2176 — the seeded profile's newest lab is 30 days old, which is CORRECT and must
//           stay that way for its neighbours. So the spec shifts profile 1's lab
//           collection dates back by a fixed number of days and shifts them forward
//           again afterwards — exactly reversible calendar arithmetic, and it is the
//           only way to age a frontier that is a MAX().
//
// Everything the fixture writes is removed in afterEach, including the dismissal row
// the second test files, so a `--repeat-each` run and every neighbouring spec see the
// database they started with.

const ARCHIVE_ROWS = '[data-testid^="upcoming-item-records-recency:archive:"]';
const CLINICAL_ROWS =
  '[data-testid^="upcoming-item-records-recency:clinical-records:"]';

// Comfortably past both declared horizons (30 days for the archive, ~15 months for
// labs) so neither assertion sits on a boundary the registry may later move.
const ARCHIVE_DAYS_BEHIND = 90;
const LAB_SHIFT_DAYS = 900;

function dayBefore(days: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

// #2176 exempts a profile whose records-recency ask #1757 already owns — one with a
// BOUND portal identity. Whether profile 1 has one depends on which neighbouring spec
// ran before this file in this worker (the portal-setup spec binds identities through
// the UI), so the precondition is MADE rather than assumed: any bound identity is
// parked as `ignored` for the duration and restored afterwards, by id.
let parkedIdentityIds: number[] = [];

function seedFixture(): void {
  const frontier = dayBefore(ARCHIVE_DAYS_BEHIND);
  withDb((db) => {
    parkedIdentityIds = (
      db
        .prepare(
          "SELECT id FROM portal_identities WHERE profile_id = 1 AND ignored = 0"
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    for (const id of parkedIdentityIds) {
      db.prepare("UPDATE portal_identities SET ignored = 1 WHERE id = ?").run(
        id
      );
    }
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct, source)
       VALUES (1, ?, 71.4, 19.2, 'fitbit-takeout')`
    ).run(frontier);
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (1, 'fitbit-takeout', 'fitbit_sleep_score', ?, ?, ?, 84)`
    ).run(frontier, `${frontier}T00:00`, `${frontier}T23:59`);
    db.prepare(
      `UPDATE medical_records SET date = date(date, '-${LAB_SHIFT_DAYS} day')
        WHERE profile_id = 1 AND category IN ('lab','biomarker')`
    ).run();
  });
}

function clearFixture(): void {
  withDb((db) => {
    db.prepare(
      "DELETE FROM body_metrics WHERE profile_id = 1 AND source = 'fitbit-takeout'"
    ).run();
    db.prepare(
      "DELETE FROM metric_samples WHERE profile_id = 1 AND source = 'fitbit-takeout'"
    ).run();
    db.prepare(
      `UPDATE medical_records SET date = date(date, '+${LAB_SHIFT_DAYS} day')
        WHERE profile_id = 1 AND category IN ('lab','biomarker')`
    ).run();
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = 1 AND signal_key LIKE 'records-recency:%'"
    ).run();
    for (const id of parkedIdentityIds) {
      db.prepare("UPDATE portal_identities SET ignored = 0 WHERE id = ?").run(
        id
      );
    }
    parkedIdentityIds = [];
  });
}

test.describe("records-recency asks (#2164 + #2176)", () => {
  test.beforeEach(() => seedFixture());
  test.afterEach(() => clearFixture());

  test("both legs render their ask, each deep-linking the thing that answers it", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();
    await page.goto("/upcoming");
    const main = page.getByRole("main");
    await expect(main.getByTestId("upcoming-total")).toBeVisible();

    // #2164 — the archive ask names the export, the streams and the frontier, and
    // links to the import page that answers it.
    const archive = main.locator(ARCHIVE_ROWS);
    await expect(archive).toHaveCount(1);
    await expect(archive).toContainText(
      "Import a fresh Fitbit (Google Takeout) export"
    );
    await expect(archive).toContainText(dayBefore(ARCHIVE_DAYS_BEHIND));
    await expect(
      archive.getByRole("link", { name: "Import a fresh Fitbit" })
    ).toHaveAttribute("href", "/integrations/fitbit-takeout");

    // #2176 — the lab ask carries BOTH fixes: upload, and connect a portal.
    const clinical = main.locator(CLINICAL_ROWS);
    await expect(clinical).toHaveCount(1);
    await expect(clinical).toContainText("Bring lab results up to date");
    await expect(
      clinical.getByRole("link", { name: "Bring lab results up to date" })
    ).toHaveAttribute("href", "/data?section=import");
    await expect(
      clinical.getByTestId("records-recency-portal-link")
    ).toHaveAttribute("href", "/integrations/patient-portals");
  });

  test("a dismissal silences the episode", async ({ page }) => {
    test.slow();
    await page.goto("/upcoming");
    const main = page.getByRole("main");
    await expect(main.getByTestId("upcoming-total")).toBeVisible();

    const archive = main.locator(ARCHIVE_ROWS);
    await expect(archive).toHaveCount(1);

    await archive.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Dismiss" })
      .click();

    // The menu closing is the action having RUN; the row disappearing is the server
    // having revalidated.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(main.locator(ARCHIVE_ROWS)).toHaveCount(0, {
      timeout: 20_000,
    });

    // One ask, one dismissal: the lab ask beside it is a different episode and is
    // untouched.
    await expect(main.locator(CLINICAL_ROWS)).toHaveCount(1);
  });
});
