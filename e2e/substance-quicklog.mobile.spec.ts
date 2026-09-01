import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { hydratedClick, settledClick, settledFill } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";
import { E2E_LOGIN_SUBSTANCE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath } from "./worker-env";

// The quick-log sheet's SUBSTANCE row (issue #3327).
//
// The row did not exist: `QUICK_LOG_DOMAIN_CENSUS` argued the whole domain out, on
// the ground that a sheet row detaches the tap from the #998 cap verdict that makes
// it honest. #3279 ruling 1 narrowed that to its premise — it presumes a cap exists —
// and this spec pins the two conditions the row ships under, which are exactly the
// two halves of that old argument:
//
//   1. NO ROW AT ALL for a profile that tracks no substance. An empty offer is worse
//      than no offer, and the curated three are the offered defaults on the PAGE that
//      offers them, never on a quick surface for somebody who logs none of them.
//   2. The cap line rides beside the tap for a substance whose target exists, and
//      nothing at all for one whose target does not.
//
// Both halves run on ONE fixture profile whose substance ledger this spec owns and
// clears, so the transition itself is what is asserted — "no row, then a row" is a
// strictly stronger statement than either state alone, and it cannot pass by
// accident on a fixture that happened to be empty.
//
// A raw context from loginAs does NOT inherit the `mobile` project's `use` block, so
// the phone viewport has to be restated or this silently runs at desktop width where
// the dock puck does not render at all (the dashboard-now.mobile.spec.ts gotcha).
const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
} as const;

// The name is a low-entropy fixture word (#868), and it is a CUSTOM substance on
// purpose: the row has to offer what #3326 lets a person name, not just the catalog.
const NAME = "Kava 2";
const PROFILE = "Substance Quick Log (e2e)";

interface QuickLogFixture {
  loginId: number;
  profileId: number;
  username: string;
}

function clearSubstanceRows(db: Database.Database, profileId: number): void {
  // Both ledgers: alcohol rides food_daily_totals (#860/#944) and everything else
  // rides substance_daily_totals, and the row is gated on EITHER being present, so
  // clearing one alone would leave the "tracks none" precondition false.
  db.prepare("DELETE FROM substance_daily_totals WHERE profile_id = ?").run(
    profileId
  );
  db.prepare(
    `DELETE FROM food_daily_totals
      WHERE profile_id = ? AND group_key = 'alcohol'`
  ).run(profileId);
  db.prepare(
    `DELETE FROM food_log_events
      WHERE profile_id = ? AND group_key = 'alcohol'`
  ).run(profileId);
  db.prepare(
    `DELETE FROM frequency_targets
      WHERE profile_id = ? AND scope_kind = 'substance'`
  ).run(profileId);
}

function clearSubstances(profileId: number): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    db.transaction(() => clearSubstanceRows(db, profileId)).immediate();
  } finally {
    db.close();
  }
}

function createQuickLogFixture(): QuickLogFixture {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    let fixture!: QuickLogFixture;
    db.transaction(() => {
      // Borrow the shared credential's already-computed fixture hash only; this spec
      // never grants, signs in as, or writes the shared substance profile.
      const passwordHash = (
        db
          .prepare("SELECT password_hash FROM logins WHERE username = ?")
          .get(E2E_LOGIN_SUBSTANCE) as { password_hash: string }
      ).password_hash;
      const suffix = `${process.pid}`;
      const username = `e2e_substance_quicklog_${suffix}`;
      const profileId = createFixtureProfile(db, `${PROFILE} ${suffix}`);
      const loginId = Number(
        db
          .prepare(
            "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
          )
          .run(username, passwordHash).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO login_profiles (login_id, profile_id, access)
         VALUES (?, ?, 'write')`
      ).run(loginId, profileId);
      fixture = { loginId, profileId, username };
    }).immediate();
    return fixture;
  } finally {
    db.close();
  }
}

function destroyQuickLogFixture(fixture: QuickLogFixture): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    db.transaction(() => {
      clearSubstanceRows(db, fixture.profileId);
      db.prepare("DELETE FROM sessions WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
      destroyFixtureProfile(db, fixture.profileId);
    }).immediate();
  } finally {
    db.close();
  }
}

test.describe("quick-log sheet: the substance row (#3327)", () => {
  test.describe.configure({ mode: "serial" });

  let page!: Page;
  let fixture: QuickLogFixture | undefined;

  test.beforeAll(async ({ browser }) => {
    fixture = createQuickLogFixture();
    try {
      page = await loginAs(
        browser,
        { username: fixture.username, password: E2E_MEMBER_PASSWORD },
        PHONE_CONTEXT
      );
    } catch (error) {
      destroyQuickLogFixture(fixture);
      fixture = undefined;
      throw error;
    }
  });

  test.beforeEach(() => {
    clearSubstances(fixture!.profileId);
  });

  test.afterAll(async () => {
    try {
      await page?.close();
    } finally {
      if (fixture) destroyQuickLogFixture(fixture);
    }
  });

  test("a profile that tracks no substance gets no row at all", async () => {
    await page.goto("/");
    const sheet = await openLogSheet(page);
    // The Consume segment is revealed first and the row is absent within it — the
    // strictly stronger statement the helper returns a locator for. "The row is not
    // visible" would also pass on a sheet that had stopped segmenting.
    const row = await showLogRow(sheet, "log-substance");
    await expect(row).toHaveCount(0);
    // The segment itself survives — the gate removes a row, never a segment.
    await expect(sheet.getByTestId("quick-log-log-food")).toBeVisible();
  });

  test("naming a substance makes the row appear, offering that substance with no cap framing", async () => {
    // Create one through the #3326 door, which is the whole point of the pairing:
    // a substance named this morning is offerable this morning.
    await page.goto("/records/specialty/substance-use");
    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    await settledFill(page, page.getByTestId("track-substance-name"), NAME);
    await settledClick(page, page.getByTestId("track-substance-save"));
    await expect(page.getByTestId(`substance-card-${NAME}`)).toBeVisible({
      timeout: 15_000,
    });

    await page.goto("/");
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-substance");
    await expect(row).toBeVisible();
    await row.click();

    const body = page.getByTestId("quick-entry-body");
    await expect(body).toHaveAttribute("data-form", "substance");
    const entry = page.getByTestId(`quick-entry-substance-${NAME}`);
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await expect(entry).toContainText(NAME);

    // NO cap framing: nobody opted into a target, so the payload carries no cap
    // status and there is nothing for the row to render. The curated three are also
    // absent — this profile has logged none of them, and the offer is what it
    // TRACKS, not the catalog.
    await expect(
      page.getByTestId(`quick-entry-substance-cap-progress-${NAME}`)
    ).toHaveCount(0);
    await expect(
      page.getByTestId("quick-entry-substance-nicotine")
    ).toHaveCount(0);

    // BOTH TAPS, because the row IS the domain's shared row control since #4424 —
    // the sheet used to offer a log and no undo, so a mis-tap had to be carried to
    // another page. Asserted as the pair rather than as the new button alone: a mount
    // that drew one of them and not the other is the per-mount field set the ruling
    // forbids.
    await expect(
      page.getByTestId(`quick-entry-substance-undo-${NAME}`)
    ).toBeVisible();
    await settledClick(
      page,
      page.getByTestId(`quick-entry-substance-log-${NAME}`)
    );
    await page.goto("/records/specialty/substance-use");
    await expect(
      page.getByTestId(`substance-week-count-${NAME}`)
    ).toContainText("2");
  });

  test("a substance with an opted-in cap carries its progress line beside the tap", async () => {
    // The other half of the narrowed argument: where a verdict EXISTS, the sheet does
    // not detach the tap from it.
    await page.goto("/records/specialty/substance-use");
    await hydratedClick(page, page.getByTestId("track-substance-panel-toggle"));
    await settledFill(page, page.getByTestId("track-substance-name"), NAME);
    await settledClick(page, page.getByTestId("track-substance-save"));

    const card = page.getByTestId(`substance-card-${NAME}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await hydratedClick(
      page,
      card.getByRole("button", { name: `Actions for ${NAME}` })
    );
    await page.getByTestId(`substance-cap-open-${NAME}`).click();
    await page.getByTestId(`substance-cap-input-${NAME}`).fill("7");
    await settledClick(page, page.getByTestId(`substance-cap-save-${NAME}`));
    await expect(
      page.getByTestId(`substance-cap-progress-${NAME}`)
    ).toBeVisible();

    await page.goto("/");
    const sheet = await openLogSheet(page);
    const row = await showLogRow(sheet, "log-substance");
    await row.click();
    const capLine = page.getByTestId(
      `quick-entry-substance-cap-progress-${NAME}`
    );
    await expect(capLine).toBeVisible({ timeout: 15_000 });
    await expect(capLine).toContainText("7");
    // Calm and factual, like every other rendering of this one line.
    await expect(capLine).not.toContainText(/streak|great|well done/i);
  });
});
