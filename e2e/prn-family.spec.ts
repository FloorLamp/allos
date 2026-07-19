import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_PRN_FAMILY,
  PRN_FAMILY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Cross-item PRN safety counters (issue #1027). The dedicated fixture profile tracks
// OTC "Ibuprofen" (confirmed 6h interval / max 4) alongside "Ibuprofen 800 mg", whose
// administration one hour before the frozen e2e clock arms the FAMILY clock. The OTC
// item — with zero administrations of its own — must render the family-held redose
// line ("Next dose in ~… across 2 items", never a false "Redose OK"), and the
// coaching-tier duplication note must surface on the dashboard rollup. Read-only on
// an isolated fixture login (#868); duplication-note dismissals are reset per test.

function resetDupDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
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
  const redoseLine = main.getByTestId("prn-redose-line").first();
  await expect(redoseLine).toBeVisible();
  await expect(redoseLine).toContainText("Next dose in ~");
  await expect(redoseLine).toContainText("1 of 4 today");
  await expect(redoseLine).toContainText("across 2 items");
  await expect(main.getByTestId("prn-redose-line")).not.toContainText(
    "Redose OK"
  );

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
  const rollup = page.getByTestId("coaching-observations");
  await expect(rollup).toBeVisible();
  await expect(rollup).toContainText(
    "Ibuprofen appears in 2 active medications"
  );
  // Calm/informational framing — the note explains the shared counters, and never
  // tells the user to change anything.
  await expect(rollup).toContainText("count together");

  await page.context().close();
});
