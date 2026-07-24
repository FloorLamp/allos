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
  MULTI_OWNER_ACTIVITY_A,
  MULTI_OWNER_ACTIVITY_B,
  MULTI_SHARED_ACTIVITY,
  E2E_LOGIN_TL_MULTI,
  TL_EAST_PROFILE,
  TL_WEST_PROFILE,
  TL_EAST_ACTIVITY,
  TL_WEST_ACTIVITY,
  MULTI_OWNER_VISIT,
  MULTI_SHARED_VISIT,
  E2E_LOGIN_MVMEDS,
  MVMEDS_SELF_PROFILE,
  MVMEDS_RO_PROFILE,
  MVMEDS_SELF_MED,
  MVMEDS_RO_MED,
  E2E_LOGIN_MVBIO,
  MVBIO_SELF_PROFILE,
  MVBIO_RO_PROFILE,
  MVBIO_SHARED_ANALYTE,
  MVBIO_SELF_ANALYTE,
  MVBIO_RO_ANALYTE,
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

// ── Multi-view Training Journal (issue #1330) ─────────────────────────────────
// The Journal's Log feed becomes a MERGED, subject-stamped card feed across the
// view-set: non-acting cards carry a subject chip, cross-profile merge candidates
// never pair (two people's activities are never duplicates), and "Log again" on
// another member's card logs it as YOURS (writeTarget: acting). Spec-OWNED fixtures
// (E2E_LOGIN_MULTI's two profiles, each seeded manual activities — see
// e2e/seed-events.ts). The log-again test writes a persistent row on the acting
// (owner) profile, so it resets that artifact for --repeat-each safety.

// Delete the log-again artifact (a copy of the shared activity created on the owner
// profile) so a re-run/retry starts clean, and return the two profile ids.
function resetMultiJournal(): { ownerId: number; sharedId: number } {
  const { ownerId, sharedId } = multiProfileIds();
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    // The owner should own ONLY its two seeded rows; a prior log-again run may have
    // added a copy of the shared activity's title on the owner — remove it.
    db.prepare("DELETE FROM activities WHERE profile_id = ? AND title = ?").run(
      ownerId,
      MULTI_SHARED_ACTIVITY
    );
  } finally {
    db.close();
  }
  return { ownerId, sharedId };
}

// Count the owner's activities carrying the shared activity's title — nonzero only
// after a "Log again" landed the shared card's session on the acting (owner) profile.
function ownerCopiesOfSharedActivity(ownerId: number): number {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM activities WHERE profile_id = ? AND title = ?"
        )
        .get(ownerId, MULTI_SHARED_ACTIVITY) as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

test.describe("Multi-view Training Journal (issue #1330)", () => {
  test("merged feed + subject chips + single-view unchanged + cross-profile merge never pairs", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiJournal();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single view (acting = owner): the owner's two cards show; the shared member's
    // card is absent, no strip, no chips — the byte-identical regression bar.
    await page.goto("/training");
    await expect(
      page
        .locator('[id^="activity-"]')
        .filter({ hasText: MULTI_OWNER_ACTIVITY_A })
    ).toBeVisible();
    await expect(
      page
        .locator('[id^="activity-"]')
        .filter({ hasText: MULTI_OWNER_ACTIVITY_B })
    ).toBeVisible();
    await expect(page.getByText(MULTI_SHARED_ACTIVITY)).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    // Toggle the shared profile into view via the profile menu.
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();

    // Multi view: the merged feed now carries the shared member's card WITH a subject
    // chip on ITS card; the acting (owner) cards never carry a chip.
    await page.goto("/training");
    const sharedCard = page
      .locator('[id^="activity-"]')
      .filter({ hasText: MULTI_SHARED_ACTIVITY });
    await expect(sharedCard).toBeVisible();
    await expect(
      sharedCard.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    // The owner's own cards are still there, without a chip anywhere on the feed.
    await expect(
      page
        .locator('[id^="activity-"]')
        .filter({ hasText: MULTI_OWNER_ACTIVITY_A })
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    // Cross-profile merge never pairs: the owner's Alpha card merge picker offers its
    // same-DAY same-PROFILE sibling (Bravo) but NEVER the shared member's same-day card.
    const ownerCard = page
      .locator('[id^="activity-"]')
      .filter({ hasText: MULTI_OWNER_ACTIVITY_A });
    await ownerCard.getByRole("button", { name: "Activity actions" }).click();
    await page.getByTestId("merge-with").click();
    await expect(
      page
        .getByTestId("merge-target")
        .filter({ hasText: MULTI_OWNER_ACTIVITY_B })
    ).toBeVisible();
    await expect(
      page
        .getByTestId("merge-target")
        .filter({ hasText: MULTI_SHARED_ACTIVITY })
    ).toHaveCount(0);

    await page.context().close();
  });

  test("Log again on another member's card logs it as yours (writeTarget: acting)", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiJournal();
    expect(ownerCopiesOfSharedActivity(ownerId)).toBe(0);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Enter multi-view, then open the Journal.
    await page.goto("/training");
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await page.goto("/training");

    const sharedCard = page
      .locator('[id^="activity-"]')
      .filter({ hasText: MULTI_SHARED_ACTIVITY });
    await expect(sharedCard).toBeVisible();

    // "Log again" on the SHARED member's card: opens a create prefill that auto-saves
    // a NEW session — on the ACTING (owner) profile, never the shared subject.
    await sharedCard.getByRole("button", { name: "Activity actions" }).click();
    await page.getByTestId("log-again").click();
    // The editor opens (docked beside the feed on desktop / overlay on mobile).
    await expect(page.getByTestId("activity-form")).toBeVisible();

    // The auto-save lands the repeated session on the OWNER — proving the write
    // targeted the actor, not the shared subject whose card it came from.
    await expect
      .poll(() => ownerCopiesOfSharedActivity(ownerId), { timeout: 15000 })
      .toBe(1);

    await page.context().close();
  });
});

// ── Multi-view Timeline with a divergent-timezone day boundary (issue #1329) ───
// A dedicated member (E2E_LOGIN_TL_MULTI) granted two profiles ~25h apart (UTC+13 EAST
// vs UTC−12 WEST), each with ONE activity dated on ITS OWN today. Single view is
// unchanged (owner-only, no chips, no divergence chrome); multi view merges both,
// bucketing each member's activity into THEIR local day — so the SAME instant lands in
// two separate "Today" day-groups, each carrying an honest per-member today badge, and
// the non-acting member's row wears a subject chip. Spec-OWNED fixtures (read-only
// viewing + the per-session view-set, so nothing persistent to reset).

// Resolve the two timeline fixture profile ids (spec-owned, so a name lookup is stable).
function timelineProfileIds(): { eastId: number; westId: number } {
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
    return { eastId: idOf(TL_EAST_PROFILE), westId: idOf(TL_WEST_PROFILE) };
  } finally {
    db.close();
  }
}

// Toggle the WEST profile into the view via the profile menu, then reload the timeline
// so the multi-view feed renders with the popover closed (no stale overlay).
async function enterTimelineMultiView(
  page: Page,
  westId: number
): Promise<void> {
  await page.goto("/timeline");
  await openProfileMenu(page);
  await settledClick(page, page.getByTestId(`view-toggle-${westId}`));
  await expect(page.getByTestId("profile-view-strip")).toBeVisible();
  await page.goto("/timeline");
  await expect(page.getByTestId("profile-view-strip")).toBeVisible();
}

test.describe("Multi-view Timeline divergent-day (issue #1329)", () => {
  test("single view unchanged; multi view merges both members with per-member Today badges + non-acting chip", async ({
    browser,
  }) => {
    test.slow();
    const { eastId, westId } = timelineProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Acting profile is EAST (lowest id / first accessible).
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      TL_EAST_PROFILE
    );

    // Single view: only EAST's activity, no strip, no chips, no divergence chrome.
    await page.goto("/timeline");
    await expect(
      page.getByText(TL_EAST_ACTIVITY, { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText(TL_WEST_ACTIVITY, { exact: false })
    ).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid^="timeline-daymark-"]')
    ).toHaveCount(0);
    await expect(page.getByTestId("timeline-mode-toggle")).toHaveCount(0);

    // Enter multi view (WEST toggled in).
    await enterTimelineMultiView(page, westId);

    // Both members' activities are merged in.
    await expect(
      page.getByText(TL_EAST_ACTIVITY, { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText(TL_WEST_ACTIVITY, { exact: false })
    ).toBeVisible();

    // The NON-acting (WEST) event wears a subject chip; the acting (EAST) event never
    // does (its subject is implied by the view strip).
    const westRow = page
      .getByTestId("timeline-event")
      .filter({ hasText: TL_WEST_ACTIVITY });
    await expect(westRow.getByTestId(`subject-chip-${westId}`)).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${eastId}"]`)
    ).toHaveCount(0);

    // Divergent-day honesty: the SAME instant is a different local date for each, so
    // BOTH members have a "Today" day-group, each badged with its own subject.
    await expect(
      page
        .locator(`[data-testid="timeline-daymark-${eastId}"]`)
        .filter({ hasText: "Today" })
    ).toBeVisible();
    await expect(
      page
        .locator(`[data-testid="timeline-daymark-${westId}"]`)
        .filter({ hasText: "Today" })
    ).toBeVisible();

    await page.context().close();
  });

  test("by-person toggle groups the merged timeline under per-member sections", async ({
    browser,
  }) => {
    test.slow();
    const { eastId, westId } = timelineProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    await enterTimelineMultiView(page, westId);

    // Default is interleaved (merged date bands, no per-member sections).
    await expect(page.getByTestId("timeline-mode-toggle")).toBeVisible();
    await expect(page.getByTestId("timeline-by-person")).toHaveCount(0);

    // Switch to by-person: each member gets its own section with its own activity.
    await followLink(
      page,
      page.getByTestId("timeline-mode-by-person"),
      /group=by-person/
    );
    await expect(page.getByTestId("timeline-by-person")).toBeVisible();
    const eastSection = page.getByTestId(`timeline-member-section-${eastId}`);
    const westSection = page.getByTestId(`timeline-member-section-${westId}`);
    await expect(eastSection).toContainText(TL_EAST_ACTIVITY);
    await expect(westSection).toContainText(TL_WEST_ACTIVITY);

    // Toggle back to interleaved.
    await followLink(
      page,
      page.getByTestId("timeline-mode-interleaved"),
      /\/timeline$/
    );
    await expect(page.getByTestId("timeline-by-person")).toHaveCount(0);

    await page.context().close();
  });
});

// ── Tier-1b bespoke lists adopt multi-view (issue #1359) ──────────────────────
// Two flat SUB-lists of otherwise-bespoke surfaces convert: the Visits "Past"
// encounters list (/records/history/visits) and the Immunizations "All recorded
// doses" list (/records/history/immunizations). The surrounding acting-only apparatus
// (appointment booking; the age-derived schedule assessment) is untouched. Each list
// chips non-acting rows + gates per-item writes on the row's profile. Representative
// browser coverage over BOTH conversions; the DB/action tiers cover the readers/gates.
// Spec-OWNED multi fixtures (E2E_LOGIN_MULTI's two profiles, each seeded one past visit
// + one recorded dose — see e2e/seed-events.ts). Read-only viewing + the per-session
// view-set, so no persistent write to reset.
test.describe("Tier-1b bespoke lists adopt multi-view (issue #1359)", () => {
  // Toggle the shared profile into the view via the profile menu's eye toggle.
  async function toggleSharedIntoView(
    page: Page,
    sharedId: number
  ): Promise<void> {
    const trigger = page.getByTestId("user-menu-trigger");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("user-menu-popover")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
  }

  test("Visits (Past encounters): single-view no chip; multi-view chips the non-acting visit row only", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single view (acting = owner): owner's past visit shows in the Past list, no strip,
    // no chips, and the shared profile's visit is absent — the byte-identical bar.
    await page.goto("/records/history/visits");
    await expect(
      page.locator("tr").filter({ hasText: MULTI_OWNER_VISIT })
    ).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_VISIT, { exact: false })
    ).toHaveCount(0);
    await expect(page.getByTestId("profile-view-strip")).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    await toggleSharedIntoView(page, sharedId);

    // Multi view: the shared visit merges into the Past list with a subject chip on ITS
    // row; the acting (owner) visit row never carries a chip.
    await expect(
      page.getByText(MULTI_SHARED_VISIT, { exact: false })
    ).toBeVisible();
    const sharedRow = page
      .locator("tr")
      .filter({ hasText: MULTI_SHARED_VISIT });
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    await page.context().close();
  });

  test("Immunizations (recorded doses): shared dose row gets a subject chip; schedule stays acting-only", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Expand "All recorded doses" (collapsed by default) — single view: no chips.
    await page.goto("/records/history/immunizations");
    await page
      .locator("summary")
      .filter({ hasText: "All recorded doses" })
      .click();
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    await toggleSharedIntoView(page, sharedId);

    // The view-set persists on the session — re-navigate for a deterministic reload
    // (details reset to collapsed), then expand once so the open state is unambiguous.
    await page.goto("/records/history/immunizations");
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await page
      .locator("summary")
      .filter({ hasText: "All recorded doses" })
      .click();
    // The shared profile's recorded dose carries the shared subject chip (only the
    // recorded-doses list chips rows — the age-derived schedule table above never
    // does, so it stays the acting profile's own schedule). The owner never chips.
    await expect(page.getByTestId(`subject-chip-${sharedId}`)).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    await page.context().close();
  });
});

// Multi-view Medications regimen boards (issue #1373 Part 1). Spec-OWNED fixtures
// (E2E_LOGIN_MVMEDS granted a WRITE base profile + a READ-ONLY second profile, each
// with one due-today scheduled medication — see e2e/seed-events.ts). Read-only in this
// spec (only reads + toggles the view-set), so it never races a neighbor and stays
// repeat-safe. Fresh cookie-less context (loginAs) so it drives the member's own session.
test.describe("Medications multi-view regimen boards (issue #1373)", () => {
  function mvMedsIds(): { selfId: number; roId: number } {
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
        selfId: idOf(MVMEDS_SELF_PROFILE),
        roId: idOf(MVMEDS_RO_PROFILE),
      };
    } finally {
      db.close();
    }
  }

  async function toggleIntoView(page: Page, id: number): Promise<void> {
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${id}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
  }

  test("single-view renders ONE board with no subject header (byte-identical structure)", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/medications");
    // The acting (self) medication renders. No multi-view board WRAPPERS / headers and
    // no leading strip in single-view — the byte-identical bar (one board, no header).
    await expect(
      page.getByText(MVMEDS_SELF_MED, { exact: false }).first() // first-ok: spec-owned med, appears in Today + Current on the one board
    ).toBeVisible();
    await expect(page.locator('[data-testid^="med-board-"]')).toHaveCount(0);
    await expect(page.getByTestId("med-today-everyone")).toHaveCount(0);
    // Its own dose check-off control is live (write on the acting profile).
    await expect(page.getByTestId("dose-status").first()).toBeVisible(); // first-ok: spec-owned single-board Today panel
    // The read-only member's med is NOT in view.
    await expect(page.getByText(MVMEDS_RO_MED, { exact: false })).toHaveCount(
      0
    );

    await page.context().close();
  });

  test("multi-view stacks a board per member behind the leading strip; the read-only board is view-only", async ({
    browser,
  }) => {
    test.slow();
    const { selfId, roId } = mvMedsIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });

    await toggleIntoView(page, roId);
    // The view-set persists on the session — re-navigate for a deterministic reload.
    await page.goto("/medications");
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();

    // The merged "Today across everyone" strip leads the page.
    await expect(page.getByTestId("med-today-everyone")).toBeVisible();

    // One board per in-view member, acting (self) first.
    const selfBoard = page.getByTestId(`med-board-${selfId}`);
    const roBoard = page.getByTestId(`med-board-${roId}`);
    await expect(selfBoard).toBeVisible();
    await expect(roBoard).toBeVisible();

    // The read-only member's board wears the RO badge and shows NO dose-confirm control.
    await expect(page.getByTestId(`med-board-ro-${roId}`)).toBeVisible();
    await expect(roBoard.getByTestId("dose-status")).toHaveCount(0);
    // Its medication still renders (read).
    await expect(
      roBoard.getByText(MVMEDS_RO_MED, { exact: false }).first() // first-ok: spec-owned board-scoped med, appears in Today + Current
    ).toBeVisible();

    // The acting (write) board keeps its live dose-confirm control.
    await expect(selfBoard.getByTestId("dose-status").first()).toBeVisible(); // first-ok: spec-owned board-scoped Today panel

    await page.context().close();
  });
});

// Multi-view Biomarkers (Results) table (issue #1331). The results table becomes a
// MERGE of per-(profile, family) partitions when several profiles are in view:
// is_latest/dedup are per member (a shared "Vitamin D" family never crosses), rows
// are subject-stamped, and the read-only member's rows show no edit/delete. Spec-OWNED
// fixture (E2E_LOGIN_MVBIO granted a WRITE base profile + a READ-ONLY second profile,
// each with a shared + a unique analyte — see e2e/seed-events.ts). Read-only in this
// spec (only reads + toggles the view-set), so it never races a neighbor and stays
// repeat-safe. Fresh cookie-less context (loginAs) so it drives the member's own session.
test.describe("Multi-view Biomarkers table (issue #1331)", () => {
  function mvBioIds(): { selfId: number; roId: number } {
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
        selfId: idOf(MVBIO_SELF_PROFILE),
        roId: idOf(MVBIO_RO_PROFILE),
      };
    } finally {
      db.close();
    }
  }

  async function toggleIntoView(page: Page, id: number): Promise<void> {
    await openProfileMenu(page);
    await settledClick(page, page.getByTestId(`view-toggle-${id}`));
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
  }

  test("single-view: only the acting member's readings, no Profile column, no chip", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVBIO,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/results/biomarkers");
    await expect(page.getByTestId("results-biomarkers")).toBeVisible();
    // The acting (self) member's unique analyte renders.
    await expect(
      page.getByText(MVBIO_SELF_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
    ).toBeVisible();
    // No leading Profile column and no subject chips in single view.
    await expect(
      page.getByRole("columnheader", { name: "Profile" })
    ).toHaveCount(0);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);
    // The read-only member's unique analyte is NOT in view.
    await expect(
      page.getByText(MVBIO_RO_ANALYTE, { exact: false })
    ).toHaveCount(0);

    await page.context().close();
  });

  test("multi-view: both members' shared family merges, chip + no write on the read-only rows", async ({
    browser,
  }) => {
    test.slow();
    const { roId } = mvBioIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVBIO,
      password: E2E_MEMBER_PASSWORD,
    });

    await toggleIntoView(page, roId);
    // The view-set persists on the session — re-navigate for a deterministic reload.
    await page.goto("/results/biomarkers");
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();

    // The leading Profile column appears in multi-view.
    await expect(
      page.getByRole("columnheader", { name: "Profile" })
    ).toBeVisible();

    // Both members' unique analytes are merged into the one table.
    await expect(
      page.getByText(MVBIO_SELF_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
    ).toBeVisible();
    await expect(
      page.getByText(MVBIO_RO_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
    ).toBeVisible();

    // The non-acting (read-only) member's rows carry its subject chip.
    const roChip = page.getByTestId(`subject-chip-${roId}`);
    await expect(roChip.first()).toBeVisible(); // first-ok: spec-owned RO fixture, its rows all chip

    // Filter to the SHARED family: BOTH members' Vitamin D rows survive — the family
    // dedup never collapsed the two people into one series (per-member partitions).
    await page.goto("/results/biomarkers?q=vitamin+d");
    await expect(page.getByTestId("profile-view-strip")).toBeVisible();
    await expect(
      page.getByRole("link", { name: MVBIO_SHARED_ANALYTE, exact: true })
    ).toHaveCount(2);

    // The read-only member's row shows NO edit/delete affordance; a self row does.
    const roRow = page.locator("tr", {
      has: page.getByTestId(`subject-chip-${roId}`),
    });
    await expect(roRow.getByTestId("overflow-menu-trigger")).toHaveCount(0);
    // At least one write affordance exists (on the acting member's own rows).
    await expect(
      page.getByTestId("overflow-menu-trigger").first() // first-ok: acting member's own write rows
    ).toBeVisible();

    await page.context().close();
  });
});
