import { test, expect } from "./fixtures";
import { type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  chartsSettled,
  dismissToast,
  hydratedClick,
  settledClick,
} from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_BULKFIX } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";

// Issue #2556 — the Body history table can CORRECT a reading, not only destroy it.
//
// The table offered delete and nothing else, so a mistyped weight could only be
// removed and retyped — and `body_metrics` is WIDE, so removing the row took that
// day's body fat and resting HR with it. The per-reading write contract (#2032) has
// been able to correct exactly these three columns all along; what the surface
// lacked was a way to name one of its cells to it. This drives that end to end.
//
// SPEC-OWNED FIXTURE (#868): its own profile and its own member login, created and
// destroyed per test. The assertions are exact values on a single row, so they must
// not ride a shared profile another spec writes to — and the neighbouring
// bulk-correction fixture, the only other body_metrics-owning profile, clears every
// row on ITS profile at test start.

const DB_PATH = workerDbPath();

interface BodyEditFixture {
  username: string;
  profileId: number;
  date: string;
  soloDate: string;
  rowId: number;
  soloRowId: number;
}

const WEIGHT_KG = 80.5;
const BODY_FAT_PCT = 21.4;
const RESTING_HR = 57;
// What the spec corrects the weight TO. A fixed target, so the write is idempotent
// and --repeat-each starts from the same place.
const CORRECTED_KG = 79.2;

function dayStr(daysAgo: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function createFixture(testInfo: TestInfo): BodyEditFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_body_edit_${suffix}`;
    const date = dayStr(4);
    const soloDate = dayStr(5);
    let profileId = 0;
    let rowId = 0;
    let soloRowId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_BULKFIX) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Body Edit (e2e) ${suffix}`);
        const loginId = Number(
          handle
            .prepare(
              "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
            )
            .run(username, passwordHash).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO login_profiles (login_id, profile_id, access)
             VALUES (?, ?, 'write')`
          )
          .run(loginId, profileId);
        // The WIDE row: all three measures on one day, which is the case the
        // per-measure menu exists for.
        rowId = Number(
          handle
            .prepare(
              `INSERT INTO body_metrics
                 (profile_id, date, weight_kg, body_fat_pct, resting_hr, source)
               VALUES (?, ?, ?, ?, ?, 'manual')`
            )
            .run(profileId, date, WEIGHT_KG, BODY_FAT_PCT, RESTING_HR)
            .lastInsertRowid
        );
        // A day carrying only a weigh-in — the "renders from state" case.
        soloRowId = Number(
          handle
            .prepare(
              `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
               VALUES (?, ?, ?, 'manual')`
            )
            .run(profileId, soloDate, WEIGHT_KG).lastInsertRowid
        );
      })
      .immediate();
    return { username, profileId, date, soloDate, rowId, soloRowId };
  } finally {
    handle.close();
  }
}

function destroyFixture(fixture: BodyEditFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare("DELETE FROM body_metrics WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM logins WHERE username = ?")
          .run(fixture.username);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

test("corrects ONE measure of a body-metrics row and leaves the day's others alone (#2556)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo);
  let page: Page | null = null;
  try {
    page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    // The history table renders at `md:` and up (the body-view stack container).
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/trends#body");
    // This table sits BELOW the starred sparkline grid and the body census, all of
    // them lazy charts — the purest sleep-page twin in #2839's sweep. Every ⋯ round
    // trip below opens a `position: fixed` panel glued to a trigger those mounts are
    // still pushing down, so gate the growth before the first one (#2862). No card
    // is named: which tiles plot depends on this spec's own fresh fixture, and a
    // hydrated `main` is the precondition an absent loading fallback needs.
    await chartsSettled(page.getByRole("main"));

    const table = page.getByTestId("body-history-table");
    await expect(table).toBeVisible();
    const rows = table.getByTestId("body-history-row");
    const wide = rows.filter({ hasText: `${BODY_FAT_PCT}%` });
    await expect(wide).toHaveCount(1);
    await expect(wide).toContainText(`${WEIGHT_KG} kg`);
    await expect(wide).toContainText(`${RESTING_HR} bpm`);

    // The row is WIDE, so the menu names each of its three measures rather than
    // offering one unqualified "Edit" that would have to guess.
    await hydratedClick(page, wide.getByTestId("overflow-menu-trigger"));
    await expect(page.getByTestId("body-history-edit-weight_kg")).toBeVisible();
    await expect(
      page.getByTestId("body-history-edit-body_fat_pct")
    ).toBeVisible();
    await expect(
      page.getByTestId("body-history-edit-resting_hr")
    ).toBeVisible();

    await hydratedClick(page, page.getByTestId("body-history-edit-weight_kg"));
    const dialog = page.getByTestId("body-metric-edit-dialog");
    // The dialog is a WRAPPER around the body domain's one row control (#4424
    // ruling 3) — the same `ReadingValueControl` the metric detail page's readings
    // table and the record's body rows mount — so it is addressed by that control's
    // own field and button rather than by markers this dialog used to own.
    await expect(dialog.getByLabel("Reading value")).toHaveValue(
      String(WEIGHT_KG)
    );
    await dialog.getByLabel("Reading value").fill(String(CORRECTED_KG));
    await settledClick(
      page,
      dialog.getByRole("button", { name: "Save", exact: true })
    );
    await expect(dialog).toHaveCount(0);

    // THE CLAIM: the weight is corrected in place and the row survives with the
    // day's other two readings untouched — which deleting and re-entering could
    // never have done.
    const corrected = table
      .getByTestId("body-history-row")
      .filter({ hasText: `${BODY_FAT_PCT}%` });
    await expect(corrected).toContainText(`${CORRECTED_KG} kg`);
    await expect(corrected).toContainText(`${RESTING_HR} bpm`);

    const handle = new Database(DB_PATH, { readonly: true });
    try {
      expect(
        handle
          .prepare(
            "SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE id = ?"
          )
          .get(fixture.rowId)
      ).toEqual({
        weight_kg: CORRECTED_KG,
        body_fat_pct: BODY_FAT_PCT,
        resting_hr: RESTING_HR,
      });
    } finally {
      handle.close();
    }

    // RENDERED FROM STATE: the weigh-in-only day offers exactly one Edit, because
    // it has exactly one reading to correct.
    const solo = table
      .getByTestId("body-history-row")
      .filter({ hasText: `${WEIGHT_KG} kg` });
    await expect(solo).toHaveCount(1);
    // The save above toasted into the bottom-right, where this table's actions column
    // and its portaled menu panel live — the DB read in between is far too fast to
    // absorb the 6s auto-dismiss (#2861).
    await dismissToast(page, "Weight updated.");
    await hydratedClick(page, solo.getByTestId("overflow-menu-trigger"));
    await expect(page.getByTestId("body-history-edit-weight_kg")).toBeVisible();
    await expect(
      page.getByTestId("body-history-edit-body_fat_pct")
    ).toHaveCount(0);
    await expect(page.getByTestId("body-history-edit-resting_hr")).toHaveCount(
      0
    );
    // Delete is still the whole-row delete it always was, and it says so.
    await expect(page.getByTestId("body-history-delete")).toHaveText(
      "Delete entry"
    );
  } finally {
    if (page) await page.context().close();
    destroyFixture(fixture);
  }
});
