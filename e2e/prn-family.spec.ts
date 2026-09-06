import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_PRN_FAMILY,
  PRN_FAMILY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { openDashboardAll, openEverythingFold } from "./helpers";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";

// Cross-item PRN safety counters (issue #1027). The dedicated fixture profile tracks
// OTC "Ibuprofen" (confirmed 6h interval / max 4) alongside "Ibuprofen 800 mg", whose
// administration one hour before the frozen e2e clock arms the FAMILY clock. The OTC
// item — with zero administrations of its own — must render the family-held redose
// line ("Next dose in ~… across 2 items", never a false "Redose OK"), and the
// coaching-tier duplication note must surface on the dashboard rollup. Read-only on
// an isolated fixture login (#868); duplication-note dismissals are reset per test.

function resetDupDismissals(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(PRN_FAMILY_PROFILE) as { id: number } | undefined;
    if (profile) {
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'med-dup:%'"
      ).run(profile.id);
    }
  } finally {
    db.close();
  }
}

test.beforeEach(() => {
  resetDupDismissals();
});

test("the OTC ibuprofen card shows the family-held redose line (no false GO)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRN_FAMILY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/medications");
  const main = page.getByRole("main");

  // The OTC item's own ledger is empty, but the 800 mg sibling dosed 1h ago — the
  // redose line must be HELD (counting down from the sibling's dose, across items),
  // never "Redose OK".
  const redoseLine = main.getByTestId("prn-redose-line").first(); // eslint-disable-line no-restricted-properties -- first-ok: the family-held redose line on this spec's DEDICATED fixture profile (E2E_LOGIN_PRN_FAMILY) — deterministic
  await expect(redoseLine).toBeVisible();
  await expect(redoseLine).toContainText("Next dose in ~");
  await expect(redoseLine).toContainText("1 of 4 in 24h");
  await expect(redoseLine).toContainText("across 2 items");
  // No surface (Today panel or med row) shows a false green light.
  await expect(
    main.getByTestId("prn-redose-line").filter({ hasText: "Redose OK" })
  ).toHaveCount(0);

  // The interval is guidance, not a lock: Taken now remains enabled, but while
  // the window is held it uses the neutral action treatment instead of CTA color.
  const row = redoseLine.locator(
    "xpath=ancestor::*[@data-testid='quick-log-prn-item']"
  );
  const takeNow = row.getByTestId("prn-log-now");
  await expect(takeNow).toBeEnabled();
  await expect(takeNow).toHaveClass(/bg-white\/70/);
  await expect(takeNow).not.toHaveClass(/bg-brand-600/);

  await page.context().close();
});

test("the therapeutic-duplication note surfaces on the dashboard coaching rollup", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRN_FAMILY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  await openDashboardAll(page);
  // The rollup is a folded BLOCK of rows since #4076 — one observation, one row,
  // all of them under one "Coaching observations" header. Coaching observations
  // are Understand's statements, and this seeded fixture's Understand band crosses
  // the three-block cap (#4065), so the rollup sits behind Understand's own fold.
  await openEverythingFold(page, "understand");
  const rollup = page.locator('[data-moment-key="coaching.observation"]');
  await expect(rollup).toBeVisible();
  await expect(rollup).toContainText(
    "Ibuprofen appears in 2 active medications"
  );
  // Calm/informational framing — the note explains the shared counters, and never
  // tells the user to change anything.
  await expect(rollup).toContainText("count together");

  await page.context().close();
});

// PRN DOSE CONTROLS LEFT THE TAIL FOR THE QUICK LOGGER (#4076 ruling 4, the #4083
// pattern verbatim). The dashboard used to render one `intake.prn:<id>` card per
// active PRN item, each hosting the full dose logger; the Consume segment's
// "Log a dose" already owned that capability, so the tail's copies retired.
//
// THIS LOGIN IS WHERE THE CLAIM MEANS ANYTHING, and that is a measurement rather
// than a preference. The six seeded manifest personas produce NO `intake.prn:`
// candidate at all — the branch needs active PRN items on a WELL day, and none of
// them has both — so a manifest-tier absence assertion for it would be vacuous.
// This fixture rendered TWO of those cards before the change (measured against the
// merge base), which is what makes the absence below a real removal.
//
// THE REMOVAL AND THE OFFER, TOGETHER: asserting only the first would pass just as
// happily on a tree where dose logging vanished instead of moving.
//
// The sheet is reached from the dock puck, which is phone-only chrome — hence the
// explicit phone context; a raw `loginAs` context does not inherit the mobile
// project's viewport.
test("PRN dose logging left the dashboard tail for the quick logger (#4076)", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_PRN_FAMILY, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    await openDashboardAll(page);

    // The control: this profile's tail rendered and holds entries, so the absence
    // below is about a populated tail rather than a selector that found nothing.
    expect(
      await page
        .getByTestId("dashboard-all-contents")
        .getByTestId("dashboard-candidate")
        .count()
    ).toBeGreaterThan(0);
    await expect(
      page.locator('[data-candidate-id^="intake.prn:"]')
    ).toHaveCount(0);

    // …and the capability is one tap away on the surface that owns it.
    const sheet = await openLogSheet(page);
    await expect(await showLogRow(sheet, "log-dose")).toBeVisible();
  } finally {
    await page.context().close();
  }
});
