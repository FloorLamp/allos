import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledClick, followLink, expectNoClippedContent } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MULTI,
  MULTI_OWNER_PROFILE,
  MULTI_SHARED_PROFILE,
  MULTI_OWNER_DOSE,
  MULTI_SHARED_DOSE,
  MULTI_OWNER_CONDITION,
  MULTI_SHARED_CONDITION,
  MULTI_OWNER_ALLERGY,
  MULTI_SHARED_ALLERGY,
  MULTI_SHARED_GOAL,
} from "./fixture-logins";

// Multi-profile viewing (issue #1096): the profile-menu view toggles + the thin
// persistent view strip + multi-view Upcoming with subject chips + a cross-profile
// dose confirm. Spec-OWNED fixtures (E2E_LOGIN_MULTI granted two dedicated profiles,
// each with its own due dose — see e2e/seed-events.ts), so the persistent
// confirm-write never races a shared-seed spec. Fresh cookie-less context (loginAs)
// so it drives the member's own session without touching the admin storageState.

// Resolve the two fixture profile ids and reset their due doses so the confirm test
// is repeat-safe (#868 fixture ownership): the cross-profile confirm writes a
// persistent intake_item_logs row, so a re-run / retry would otherwise find the dose
// already taken. Short-lived connection with a busy timeout so it never contends with
// the running server on the WAL DB.
function resetMultiFixture(): { ownerId: number; sharedId: number } {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string): number =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    const ownerId = idOf(MULTI_OWNER_PROFILE);
    const sharedId = idOf(MULTI_SHARED_PROFILE);
    for (const [name, pid] of [
      [MULTI_OWNER_DOSE, ownerId],
      [MULTI_SHARED_DOSE, sharedId],
    ] as [string, number][]) {
      db.prepare(
        `DELETE FROM intake_item_logs
          WHERE item_id IN (
            SELECT id FROM intake_items WHERE name = ? AND profile_id = ?
          )`
      ).run(name, pid);
    }
    return { ownerId, sharedId };
  } finally {
    db.close();
  }
}

// Reset the multi login's one-time multiview-hint "seen" flag (login_settings) so the
// hint test is repeat-safe (#868 fixture ownership) — dismissing it persists, and a
// re-run/retry would otherwise never see the hint. Same short-lived busy-timeout
// connection as resetMultiFixture.
function resetMultiviewHint(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const login = db
      .prepare("SELECT id FROM logins WHERE username = ?")
      .get(E2E_LOGIN_MULTI) as { id: number } | undefined;
    if (login) {
      db.prepare(
        "DELETE FROM login_settings WHERE login_id = ? AND key = 'hint_multiview_seen'"
      ).run(login.id);
    }
  } finally {
    db.close();
  }
}

// Open the profile menu popover reliably past the pre-hydration disable gate (#830):
// the trigger renders disabled until mounted, so wait for it to enable, then click,
// then wait for the popover to show.
async function openProfileMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId("user-menu-trigger");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("user-menu-popover")).toBeVisible();
}

test.describe("Multi-profile viewing (issue #1096)", () => {
  test("toggle a second profile into view → merged Upcoming with subject chips, cross-profile confirm, strip toggles", async ({
    browser,
  }) => {
    // Local `next dev` compiles /upcoming on first hit.
    test.slow();
    const { sharedId } = resetMultiFixture();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Acting profile is the owner (lowest id / first accessible).
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      MULTI_OWNER_PROFILE
    );

    await page.goto("/upcoming");

    // Single-view default: only the owner's dose, no subject chips, no view strip.
    await expect(
      page.getByText(MULTI_OWNER_DOSE, { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_DOSE, { exact: false })
    ).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    // Toggle the shared profile INTO the view via the profile menu's eye toggle.
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));

    // Multi-view now: the persistent strip appears, the shared profile's chip shows,
    // and the shared profile's due dose is merged in with a subject chip on ITS row
    // (the display rule: names show iff >1 profile in view).
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await expect(page.getByTestId(`view-chip-${sharedId}`)).toBeVisible();
    const sharedRow = page
      .locator('[data-testid^="upcoming-item-"]')
      .filter({ hasText: MULTI_SHARED_DOSE });
    await expect(sharedRow).toBeVisible();
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();

    // Confirm the SHARED profile's dose from its own row (a cross-profile write:
    // acting profile stays the owner). The row drops off once taken.
    await settledClick(
      page,
      sharedRow.getByRole("button", { name: "Mark taken" })
    );
    await expect(
      page.getByText(MULTI_SHARED_DOSE, { exact: false })
    ).toHaveCount(0);
    // Acting profile is unchanged by a cross-profile confirm.
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      MULTI_OWNER_PROFILE
    );

    // Remove the shared profile from the view via the strip's × — the strip and
    // all subject chips disappear (back to single-view).
    await settledClick(page, page.getByTestId(`view-chip-remove-${sharedId}`));
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    await page.context().close();
  });

  // Add the shared profile to the view via the profile menu (shared setup for the
  // presentation tests below). The view-set persists on the session, so a fresh
  // navigation reloads multi-view with the profile menu popover closed — no stale
  // overlay to intercept a later click. Returns after the multi-view strip is showing.
  async function enterMultiView(page: Page, sharedId: number): Promise<void> {
    await page.goto("/upcoming");
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await page.goto("/upcoming");
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
  }

  test("chips only on non-acting rows + phone-width title integrity (issue #1327 fix 1)", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiFixture();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    await enterMultiView(page, sharedId);

    // Chip only NON-acting rows: the shared (non-acting) profile's dose row carries a
    // chip; the owner's own (acting) rows NEVER do — the strip already names who's
    // acting. (Each profile has several due rows here, so scope the positive check to a
    // named row and assert the owner's chip is absent anywhere.)
    const sharedRowDesktop = page
      .locator('[data-testid^="upcoming-item-"]')
      .filter({ hasText: MULTI_SHARED_DOSE });
    await expect(
      sharedRowDesktop.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    // Phone width: the chip drops to its own line and the title is NOT crushed to an
    // ellipsis (the "C…" regression). Assert the non-acting row's title is not
    // truncated (its content fits its box) and nothing overflows the clipped shell.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/upcoming");
    const sharedRow = page
      .locator('[data-testid^="upcoming-item-"]')
      .filter({ hasText: MULTI_SHARED_DOSE });
    await expect(sharedRow).toBeVisible();
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    const titleLink = sharedRow.getByRole("link", {
      name: MULTI_SHARED_DOSE,
      exact: false,
    });
    const truncated = await titleLink.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1
    );
    expect(truncated, "title crushed to an ellipsis at 390px").toBe(false);
    await expectNoClippedContent(page);

    await page.context().close();
  });

  test("by-person toggle groups the merged list under per-member headers (issue #1327 fix 2)", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiFixture();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    await enterMultiView(page, sharedId);

    // Default is interleaved (date bands, no per-member sections).
    await expect(page.getByTestId("upcoming-mode-toggle")).toBeVisible();
    await expect(page.getByTestId("by-person-view")).toHaveCount(0);

    // Switch to by-person: each member gets its own section with its own dose.
    await followLink(
      page,
      page.getByTestId("mode-by-person"),
      /group=by-person/
    );
    await expect(page.getByTestId("by-person-view")).toBeVisible();
    const ownerSection = page.getByTestId(`member-section-${ownerId}`);
    const sharedSection = page.getByTestId(`member-section-${sharedId}`);
    await expect(ownerSection).toBeVisible();
    await expect(sharedSection).toBeVisible();
    await expect(ownerSection).toContainText(MULTI_OWNER_DOSE);
    await expect(sharedSection).toContainText(MULTI_SHARED_DOSE);

    // Toggle back to interleaved.
    await followLink(page, page.getByTestId("mode-interleaved"), /\/upcoming$/);
    await expect(page.getByTestId("by-person-view")).toHaveCount(0);

    await page.context().close();
  });

  test("one-time multiview hint dismisses once and stays gone (issue #1327 fix 7)", async ({
    browser,
  }) => {
    test.slow();
    resetMultiFixture();
    resetMultiviewHint();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single-view default with a multi-profile login → the discoverability hint shows.
    await page.goto("/upcoming");
    await expect(page.getByTestId("multiview-hint")).toBeVisible();

    // Dismiss it — the hint disappears.
    await settledClick(page, page.getByTestId("multiview-hint-dismiss"));
    await expect(page.getByTestId("multiview-hint")).toHaveCount(0);

    // And stays gone across a reload (the per-login "seen" flag persisted).
    await page.goto("/upcoming");
    await expect(page.getByTestId("multiview-hint")).toHaveCount(0);

    await page.context().close();
  });
});

// ── Tier-1 record lists adopt multi-view (issue #1328) ────────────────────────
// The 8 flat record lists (Conditions/Allergies/Procedures/Family history/Care plan/
// Health goals/Genomics/Imaging) render subject chips on non-acting rows + gate per-item
// writes on the row's profile. Representative browser coverage over Conditions +
// Allergies (loop-composed) and Health goals (set-based); the rest are pattern-identical
// and covered by the DB tier. Spec-OWNED multi fixtures (E2E_LOGIN_MULTI's two profiles,
// each seeded a condition/allergy/goal — see e2e/seed-events.ts). Read-only viewing +
// the per-session view-set, so no persistent write to reset.

// Resolve the two multi fixture profile ids (spec-owned, so a name lookup is stable).
function multiProfileIds(): { ownerId: number; sharedId: number } {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string): number =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    return {
      ownerId: idOf(MULTI_OWNER_PROFILE),
      sharedId: idOf(MULTI_SHARED_PROFILE),
    };
  } finally {
    db.close();
  }
}

test.describe("Tier-1 record lists adopt multi-view (issue #1328)", () => {
  test("Conditions: single-view shows no chips; multi-view chips the non-acting row only", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single view (acting = owner): owner's condition shows, no strip, no chips, and the
    // shared profile's condition is absent — the byte-identical regression bar.
    await page.goto("/records/problems");
    await expect(
      page.getByText(MULTI_OWNER_CONDITION, { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_CONDITION, { exact: false })
    ).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    // Toggle the shared profile into view.
    const trigger = page.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("user-menu-popover")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));

    // Multi view: the strip appears, the shared condition merges in with a subject chip
    // on ITS row, and the acting (owner) row never carries a chip.
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_CONDITION, { exact: false })
    ).toBeVisible();
    // Scope the chip check to the shared condition's own row (Conditions + Allergies
    // both render on /records/problems, so the shared chip appears on more than one row).
    const sharedConditionRow = page
      .locator("tr")
      .filter({ hasText: MULTI_SHARED_CONDITION });
    await expect(
      sharedConditionRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    await page.context().close();
  });

  test("Allergies: shared row gets a subject chip in multi-view", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/records/problems");
    // The stored "Recorded allergies" table (single view: owner only, no chip). Scope to
    // the table row — the substance also appears in the merged "Known allergies" card.
    await expect(
      page.locator("tr").filter({ hasText: MULTI_OWNER_ALLERGY })
    ).toBeVisible();
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    const trigger = page.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("user-menu-popover")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));

    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    // The shared allergy's row carries the shared subject chip; the owner never does.
    const sharedRow = page
      .locator("tr")
      .filter({ hasText: MULTI_SHARED_ALLERGY });
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    await page.context().close();
  });

  test("Health goals (set-based reader): shared row gets a subject chip in multi-view", async ({
    browser,
  }) => {
    test.slow();
    const { sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/records/care/overview");
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    const trigger = page.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("user-menu-popover")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));

    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_GOAL, { exact: false })
    ).toBeVisible();
    const sharedGoalRow = page
      .locator("tr")
      .filter({ hasText: MULTI_SHARED_GOAL });
    await expect(
      sharedGoalRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();

    await page.context().close();
  });
});
