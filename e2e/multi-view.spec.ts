import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  settledClick,
  followLink,
  expectNoClippedContent,
  expectInView,
  hydratedClick,
  openMobileDrawer,
  settledBoxes,
} from "./helpers";
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
  MVMEDS_WARD_PROFILE,
  MVMEDS_WARD_MED,
  E2E_LOGIN_MVBIO,
  MVBIO_SELF_PROFILE,
  MVBIO_RO_PROFILE,
  MVBIO_SHARED_ANALYTE,
  MVBIO_SELF_ANALYTE,
  MVBIO_RO_ANALYTE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

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
  const dbPath = workerDbPath();
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
  const dbPath = workerDbPath();
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

// Open the switcher panel reliably past the pre-hydration disable gate (#830):
// the identity bar renders disabled until mounted, so wait for it to enable, then
// click, then wait for the panel to show. Desktop viewport — the phone's top
// drawer is `profile-switcher-panel-mobile` (see shell.mobile.spec.ts).
async function openProfileSwitcher(page: Page): Promise<void> {
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
}

// Remove a profile from the view-set. The strip's per-chip × retired with the
// strip; the ONE control that owns view membership is the panel's eye toggle.
async function removeFromView(page: Page, profileId: number): Promise<void> {
  await openProfileSwitcher(page);
  await settledClick(page, page.getByTestId(`view-toggle-${profileId}`));
}

test.describe("Multi-profile viewing (issue #1096)", () => {
  test("toggle a second profile into view → merged Upcoming with subject chips, cross-profile confirm, bar toggles", async ({
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
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      MULTI_OWNER_PROFILE
    );

    await page.goto("/upcoming");

    // Single-view default: only the owner's dose, no subject chips, one avatar
    // on the identity bar.
    await expect(
      page.getByText(MULTI_OWNER_DOSE, { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText(MULTI_SHARED_DOSE, { exact: false })
    ).toHaveCount(0);
    await expectInView(page, 1);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    // Toggle the shared profile INTO the view via the switcher panel's eye toggle.
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));

    // Multi-view now: the bar stacks a second avatar, and the shared profile's due
    // dose is merged in with a subject chip on ITS row (the display rule: names
    // show iff >1 profile in view).
    await expectInView(page, 2);
    await expect(
      page
        .getByTestId("profile-identity-bar")
        .getByTestId(`identity-avatar-${sharedId}`)
    ).toBeVisible();
    const sharedRow = page
      .locator('[data-testid^="upcoming-item-"]')
      .filter({ hasText: MULTI_SHARED_DOSE });
    await expect(sharedRow).toBeVisible();
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();

    // Confirm the SHARED profile's dose from its own row (a cross-profile write:
    // acting profile stays the owner). The row drops off once taken.
    // STILL "Mark taken", and deliberately: this row is `DoseConfirmButton`, whose
    // form-to-button conversion is the one #4753 mount the owner has not released, so
    // the dose family's copy migration stops at the row control (#4753 ruling 4).
    await settledClick(
      page,
      sharedRow.getByRole("button", { name: "Mark taken", exact: true })
    );
    await expect(
      page.getByText(MULTI_SHARED_DOSE, { exact: false })
    ).toHaveCount(0);
    // Acting profile is unchanged by a cross-profile confirm.
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      MULTI_OWNER_PROFILE
    );

    // Remove the shared profile from the view via the panel's eye — the stacked
    // avatar and all subject chips disappear (back to single-view).
    await removeFromView(page, sharedId);
    await expectInView(page, 1);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    await page.context().close();
  });

  // Add the shared profile to the view via the switcher panel (shared setup for the
  // presentation tests below). The view-set persists on the session, so a fresh
  // navigation reloads multi-view with the panel closed — no stale overlay to
  // intercept a later click. Returns once the bar shows both profiles.
  async function enterMultiView(page: Page, sharedId: number): Promise<void> {
    await page.goto("/upcoming");
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expectInView(page, 2);
    await page.goto("/upcoming");
    await expectInView(page, 2);
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
    ).toContainText(MULTI_SHARED_PROFILE);
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

  // #1801's phone assertion, RE-POINTED (#4102). It used to read the top bar's own
  // mount and check that the control drew no frame — bar CONTENT, not a card
  // floating in a bar (#1539's finding). That bar retired; the identity now sits at
  // the top of the More drawer, which is a narrow column like the sidebar, so it is
  // the SAME sidebar-surface control and it is framed like one. The frame claim
  // therefore goes with the surface it described; what survives is the part that was
  // never about the frame — both in-view profiles named, acting first, and the row
  // fitting its column without clipping.
  test("the drawer's identity bar names both in-view profiles at 390px, acting first (#1801)", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiFixture();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    await enterMultiView(page, sharedId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/upcoming");

    // Nothing identity-shaped is on screen until the drawer opens: the dock is the
    // phone's one chrome and it never carries identity.
    await expect(page.getByTestId("profile-identity-bar-mobile")).toHaveCount(
      0
    );
    await expect(page.getByTestId("profile-identity-bar")).not.toBeVisible();

    const drawer = await openMobileDrawer(page);
    const bar = drawer.getByTestId("profile-identity-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByTestId(`identity-avatar-${ownerId}`)).toBeVisible();
    await expect(bar.getByTestId(`identity-avatar-${sharedId}`)).toBeVisible();
    await expect(bar.getByTestId(`identity-avatar-${ownerId}`)).toHaveAttribute(
      "data-acting",
      "true"
    );
    await expect(bar.getByTestId("identity-names")).toContainText(
      `${MULTI_OWNER_PROFILE}, ${MULTI_SHARED_PROFILE}`
    );

    // Avatars have a FIXED footprint, so a long name costs nothing: the name line
    // truncates inside the bar instead of pushing the stack out of its column.
    // Measured against the DRAWER that contains it, not against the 390px viewport
    // — the drawer is the box this row has to fit, and it is narrower.
    const [barBox, drawerBox] = await settledBoxes([bar, drawer]);
    expect(
      barBox.x + barBox.width,
      "the identity row overflows the drawer's column"
    ).toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 1);
    await expectNoClippedContent(page);

    // Desktop renders the SAME control at the top of the sidebar — same component,
    // same acting-first ordering, same frame.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/upcoming");
    const desktopBar = page.getByTestId("profile-identity-bar");
    await expect(desktopBar).toBeVisible();
    await expect(
      desktopBar.getByTestId(`identity-avatar-${sharedId}`)
    ).toBeVisible();
    const desktopFrame = await desktopBar.evaluate(
      (el) => getComputedStyle(el).borderTopWidth
    );
    expect(desktopFrame).not.toBe("0px");

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
  const dbPath = workerDbPath();
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
  test("conditions, allergies, and goals stay plain in single view and stamp only shared rows in multi-view", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = multiProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // First visit all three readers in the acting profile's plain single-view state.
      await page.goto("/records/problems/conditions");
      await expect(
        page.getByText(MULTI_OWNER_CONDITION, { exact: false })
      ).toBeVisible();
      await expect(
        page.getByText(MULTI_SHARED_CONDITION, { exact: false })
      ).toHaveCount(0);
      await expectInView(page, 1);
      await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(
        0
      );

      await page.goto("/records/problems/allergies");
      await expect(
        page.locator("tr").filter({ hasText: MULTI_OWNER_ALLERGY })
      ).toBeVisible();
      await expect(
        page.locator("tr").filter({ hasText: MULTI_SHARED_ALLERGY })
      ).toHaveCount(0);
      await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(
        0
      );

      await page.goto("/records/care/overview#health-goals");
      await expectInView(page, 1);
      await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(
        0
      );

      // Toggle once. The session view-set must survive navigation across all readers.
      await openProfileSwitcher(page);
      await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
      await expectInView(page, 2);
      const sharedGoalRow = page
        .locator("tr")
        .filter({ hasText: MULTI_SHARED_GOAL });
      await expect(
        sharedGoalRow.getByTestId(`subject-chip-${sharedId}`)
      ).toBeVisible();

      await page.goto("/records/problems/conditions");
      await expectInView(page, 2);
      const sharedConditionRow = page
        .locator("tr")
        .filter({ hasText: MULTI_SHARED_CONDITION });
      await expect(
        sharedConditionRow.getByTestId(`subject-chip-${sharedId}`)
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="subject-chip-${ownerId}"]`)
      ).toHaveCount(0);

      await page.goto("/records/problems/allergies");
      await expectInView(page, 2);
      const sharedAllergyRow = page
        .locator("tr")
        .filter({ hasText: MULTI_SHARED_ALLERGY });
      await expect(
        sharedAllergyRow.getByTestId(`subject-chip-${sharedId}`)
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="subject-chip-${ownerId}"]`)
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});

// ── Multi-view Training Log (issue #1330) ─────────────────────────────────
// The Log feed becomes a MERGED, subject-stamped card feed across the
// view-set: non-acting cards carry a subject chip, cross-profile merge candidates
// never pair (two people's activities are never duplicates), and "Duplicate activity" on
// another member's card logs it as YOURS (writeTarget: acting). Spec-OWNED fixtures
// (E2E_LOGIN_MULTI's two profiles, each seeded manual activities — see
// e2e/seed-events.ts). The duplicate-activity test writes a persistent row on the acting
// (owner) profile, so it resets that artifact for --repeat-each safety.

// Delete the duplicate-activity artifact (a copy of the shared activity created on the owner
// profile) so a re-run/retry starts clean, and return the two profile ids.
function resetMultiTrainingLog(): { ownerId: number; sharedId: number } {
  const { ownerId, sharedId } = multiProfileIds();
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    // The owner should own ONLY its two seeded rows; a prior duplicate-activity run may have
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
// after "Duplicate activity" copied the shared card's session to the acting (owner) profile.
function ownerCopiesOfSharedActivity(ownerId: number): number {
  const dbPath = workerDbPath();
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

test.describe("Multi-view Training Log (issue #1330)", () => {
  test("merged feed + subject chips + single-view unchanged + cross-profile merge never pairs", async ({
    browser,
  }) => {
    test.slow();
    const { sharedId } = resetMultiTrainingLog();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single view (acting = owner): the owner's two cards show; the shared member's
    // card is absent, no strip, no chips — the byte-identical regression bar.
    await page.goto("/training?tab=log");
    await expect(
      page
        .getByTestId("history-row")
        .filter({ hasText: MULTI_OWNER_ACTIVITY_A })
    ).toBeVisible();
    await expect(
      page
        .getByTestId("history-row")
        .filter({ hasText: MULTI_OWNER_ACTIVITY_B })
    ).toBeVisible();
    await expect(page.getByText(MULTI_SHARED_ACTIVITY)).toHaveCount(0);
    await expectInView(page, 1);
    await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(0);

    // Toggle the shared profile into view via the profile menu.
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expectInView(page, 2);

    // Multi view: the merged feed now carries the shared member's card WITH a subject
    // chip on ITS card; the acting (owner) cards never carry a chip.
    //
    // THE MERGE IS A DEEP-LINKED MODE, NOT A SWITCHER (#1463, and #4079's named
    // retirement of the Log's private multi-view). The Log renders through the shared
    // history substrate, whose household read is `?view=everyone` — so having a member
    // in VIEW scope makes the mode available and the URL is what asks for it. A plain
    // `?tab=log` stays the acting profile's own log, which is asserted below.
    await page.goto("/training?tab=log");
    await expect(page.getByText(MULTI_SHARED_ACTIVITY)).toHaveCount(0);
    await page.goto("/training?tab=log&view=everyone");
    const sharedCard = page
      .getByTestId("history-row")
      .filter({ hasText: MULTI_SHARED_ACTIVITY });
    await expect(sharedCard).toBeVisible();
    // WHOSE ROW IT IS, in the substrate's own grammar (#4079). The Log's card carried
    // the caller-owned `SubjectChip` slot; the shared row names its subject in one
    // span beside the title, which is what every other family in `?view=everyone`
    // already does. The row-level geometry of that span — painted width against every
    // clipping ancestor, at the smallest phone — is owned by
    // e2e/history-everyone.spec.ts over BOTH mounts, so it is not re-measured here.
    await expect(sharedCard.getByTestId("history-row-subject")).toHaveText(
      MULTI_SHARED_PROFILE
    );
    // The owner's own rows are still there, and in a merged read EVERY row names its
    // subject — including the acting profile's, which is the substrate's rule and the
    // one e2e/history-everyone.spec.ts pins for the other families. What must never
    // happen is two rows wearing the same name.
    const ownerCard = page
      .getByTestId("history-row")
      .filter({ hasText: MULTI_OWNER_ACTIVITY_A });
    await expect(ownerCard).toBeVisible();
    await expect(ownerCard.getByTestId("history-row-subject")).toHaveText(
      MULTI_OWNER_PROFILE
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/training?tab=log&view=everyone");
    await expect(sharedCard.getByTestId("history-row-subject")).toBeVisible();
    await expectNoClippedContent(page);

    // Cross-profile merge never pairs: the owner's Alpha record's merge picker
    // offers its same-DAY same-PROFILE sibling (Bravo) but NEVER the shared
    // member's same-day card. The menu lives on the canonical record.
    const ownerRow = page
      .getByTestId("history-row")
      .filter({ hasText: MULTI_OWNER_ACTIVITY_A });
    // The row is one line with a title LINK (#4079: the Log renders through the
    // shared history substrate); the record is behind that link, not the whole row.
    await hydratedClick(page, ownerRow.getByTestId("history-row-title"));
    await page
      .getByTestId("training-activity-page")
      .getByRole("button", { name: "Activity actions" })
      .click();
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

  test("Duplicate activity on another member's record logs it as yours (writeTarget: acting)", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = resetMultiTrainingLog();
    expect(ownerCopiesOfSharedActivity(ownerId)).toBe(0);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Enter multi-view, then open the Training Log.
    await page.goto("/training?tab=log");
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expectInView(page, 2);
    // The household read is the substrate's deep-linked mode (#1463/#4079).
    await page.goto("/training?tab=log&view=everyone");

    const sharedCard = page
      .getByTestId("history-row")
      .filter({ hasText: MULTI_SHARED_ACTIVITY });
    await expect(sharedCard).toBeVisible();

    // "Duplicate activity" on the SHARED member's record opens a create prefill that
    // auto-saves a NEW session — on the ACTING (owner) profile, never the
    // shared subject. Open the canonical record for its menu.
    await hydratedClick(page, sharedCard.getByTestId("history-row-title"));
    await page
      .getByTestId("training-activity-page")
      .getByRole("button", { name: "Activity actions" })
      .click();
    await page.getByTestId("duplicate-activity").click();
    // The shared activity workspace opens.
    await expect(page.getByTestId("activity-form")).toBeVisible();

    // The auto-save lands the repeated session on the OWNER — proving the write
    // targeted the actor, not the shared subject whose card it came from.
    await expect
      .poll(() => ownerCopiesOfSharedActivity(ownerId), { timeout: 15000 })
      .toBe(1);

    await page.context().close();
  });
});

// ── THE RECORD'S MERGED VIEW ACROSS THE DATE LINE (issue #1329, re-housed #3958) ──
//
// A dedicated member (E2E_LOGIN_TL_MULTI) granted two profiles ~25h apart (UTC+13 EAST
// vs UTC−12 WEST), each with ONE activity dated on ITS OWN today — so their local
// calendar days ALWAYS differ whatever instant the run starts at. That is the whole
// point: a merge bucketing in one shared clock would put both on one day and look
// right most of the time.
//
// TWO HALVES OF THE TIMELINE VERSION DID NOT COME ACROSS, each for its own reason:
//
//   • the BY-PERSON toggle. #3958 rules "No view switcher" outright — the page follows
//     the acting profile, the sidebar is the one profile switcher, and the merged view
//     survives only as the chip-less deep-linked `?view=everyone` (#1463). Deliberate.
//     `byPersonTimelines` is still exported and now has no consumer.
//
//   • the DIVERGENT-DAY marks. `mergeMemberTimelines` still computes them and the
//     record does not render them. That one is a GAP rather than a decision, recorded
//     on #3958 rather than built here — so this asserts the merge it CAN see instead
//     of pretending the marks went by design.
//
// Per-row write gating is e2e/history-everyone.spec.ts's. What is here is the thing
// only THIS fixture can ask, because only it straddles the date line.

// Resolve the two timeline fixture profile ids (spec-owned, so a name lookup is stable).
function timelineProfileIds(): { eastId: number; westId: number } {
  const dbPath = workerDbPath();
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

test.describe("the record's merged view across the date line (#1329)", () => {
  test("single view shows one member and no chips; the merged view carries both, each naming its own subject", async ({
    browser,
  }) => {
    test.slow();
    const { westId } = timelineProfileIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TL_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Acting profile is EAST (lowest id / first accessible).
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        TL_EAST_PROFILE
      );

      // SINGLE VIEW: only EAST's activity, and no attribution at all — a subject chip
      // on a page showing one subject would be noise.
      await page.goto("/history");
      const rows = page.getByTestId("history-row");
      await expect(rows.filter({ hasText: TL_EAST_ACTIVITY })).toHaveCount(1);
      await expect(rows.filter({ hasText: TL_WEST_ACTIVITY })).toHaveCount(0);
      await expect(page.getByTestId("history-row-subject")).toHaveCount(0);

      // MERGED: both members' activities, each still bucketed in its OWN local day —
      // which is what the ~25h spread makes checkable. `?view=everyone` is a
      // deep-linked mode, so entering the view-set is not enough on its own.
      await page.goto("/history");
      await openProfileSwitcher(page);
      await settledClick(page, page.getByTestId(`view-toggle-${westId}`));
      await expectInView(page, 2);
      await page.goto("/history?view=everyone");

      const eastRow = rows.filter({ hasText: TL_EAST_ACTIVITY }).first(); // first-ok: one seeded activity carries this fixture-owned title
      const westRow = rows.filter({ hasText: TL_WEST_ACTIVITY }).first(); // first-ok: one seeded activity carries this fixture-owned title
      await expect(eastRow).toBeVisible();
      await expect(westRow).toBeVisible();

      // EVERY row is attributed here, and each names its OWN subject — the record's
      // rule, not the timeline's. `/timeline` left the acting member's row bare on the
      // grounds that its subject was implied by the view strip; the record has no view
      // strip and #534 gives every row its subject chip, so an unattributed row in a
      // merged view would be the ambiguous one. Asserted on BOTH members with
      // DIFFERENT expected names, which is what makes this "each names its own"
      // rather than "some chip is present".
      await expect(westRow.getByTestId("history-row-subject")).toHaveText(
        TL_WEST_PROFILE
      );
      await expect(eastRow.getByTestId("history-row-subject")).toHaveText(
        TL_EAST_PROFILE
      );
    } finally {
      await page.context().close();
    }
  });
});

test.describe("Tier-1b bespoke lists adopt multi-view (issue #1359)", () => {
  // Toggle the shared profile into the view via the profile menu's eye toggle.
  async function toggleSharedIntoView(
    page: Page,
    sharedId: number
  ): Promise<void> {
    const trigger = page.getByTestId("profile-identity-bar");
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expectInView(page, 2);
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
    await expectInView(page, 1);
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
    await expectInView(page, 2);
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
  // Resolve the three fixture profile ids, and clear the ward's dose log so the
  // cross-profile take below is repeat-safe (#868 fixture ownership) — that take is
  // the ONE persistent write this fixture carries, and a re-run or retry would
  // otherwise find the dose already taken and have nothing to press.
  function mvMedsIds(): {
    selfId: number;
    roId: number;
    wardId: number;
    wardMedId: number;
  } {
    const dbPath = workerDbPath();
    const db = new Database(dbPath);
    try {
      db.pragma("busy_timeout = 5000");
      const idOf = (name: string): number =>
        (
          db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
            id: number;
          }
        ).id;
      const wardId = idOf(MVMEDS_WARD_PROFILE);
      db.prepare(
        `DELETE FROM intake_item_logs
          WHERE item_id IN (
            SELECT id FROM intake_items WHERE name = ? AND profile_id = ?
          )`
      ).run(MVMEDS_WARD_MED, wardId);
      return {
        selfId: idOf(MVMEDS_SELF_PROFILE),
        roId: idOf(MVMEDS_RO_PROFILE),
        wardId,
        wardMedId: (
          db
            .prepare(
              "SELECT id FROM intake_items WHERE name = ? AND profile_id = ?"
            )
            .get(MVMEDS_WARD_MED, wardId) as { id: number }
        ).id,
      };
    } finally {
      db.close();
    }
  }

  async function toggleIntoView(
    page: Page,
    id: number,
    inView = 2
  ): Promise<void> {
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${id}`));
    await expectInView(page, inView);
  }

  test("single-view stays plain, then multi-view stacks writable and read-only boards", async ({
    browser,
  }) => {
    test.slow();
    const { selfId, roId } = mvMedsIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications");
      // The acting medication renders without multi-view wrappers or a leading strip.
      await expect(
        page.getByText(MVMEDS_SELF_MED, { exact: false }).first() // first-ok: spec-owned med, appears in Today + Current on the one board
      ).toBeVisible();
      await expect(page.locator('[data-testid^="med-board-"]')).toHaveCount(0);
      await expect(page.getByTestId("med-today-everyone")).toHaveCount(0);
      await expect(page.getByTestId("dose-status").first()).toBeVisible(); // first-ok: spec-owned single-board Today panel
      await expect(page.getByText(MVMEDS_RO_MED, { exact: false })).toHaveCount(
        0
      );

      await toggleIntoView(page, roId);
      // Re-navigation proves the selected view-set persists on the session.
      await page.goto("/medications");
      await expectInView(page, 2);
      await expect(page.getByTestId("med-today-everyone")).toBeVisible();

      const selfBoard = page.getByTestId(`med-board-${selfId}`);
      const roBoard = page.getByTestId(`med-board-${roId}`);
      await expect(selfBoard).toBeVisible();
      await expect(roBoard).toBeVisible();
      await expect(page.getByTestId(`med-board-ro-${roId}`)).toBeVisible();
      await expect(roBoard.getByTestId("dose-status")).toHaveCount(0);
      await expect(
        roBoard.getByText(MVMEDS_RO_MED, { exact: false }).first() // first-ok: spec-owned board-scoped med, appears in Today + Current
      ).toBeVisible();
      await expect(selfBoard.getByTestId("dose-status").first()).toBeVisible(); // first-ok: spec-owned board-scoped Today panel
    } finally {
      await page.context().close();
    }
  });

  // THE STRIP ANSWERS THE ROW IT SHOWS (#4429). "Today across everyone" listed each
  // member's due doses as jump links only, so the one surface that gathers the
  // household's doses was the one that could not resolve any of them — a caregiver had
  // to travel to a board for a tap the board was already offering. These are found rows
  // on a page the caregiver has already reached, so the control is the SHARED
  // tri-state, write-gated per member, with no subject picker and no acting switch.
  test("the everyone strip resolves a writable member's due dose and leaves a read-only member's alone", async ({
    browser,
  }) => {
    test.slow();
    const { selfId, roId, wardId, wardMedId } = mvMedsIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVMEDS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications");
      await toggleIntoView(page, roId, 2);
      // A view toggle leaves the panel OPEN, and the trigger is a toggle — so a second
      // `openProfileSwitcher` on the same page would CLOSE it. Re-navigating between
      // the two is what makes the second open deterministic rather than a coin flip on
      // panel state; the re-navigation after them also proves the three-member view
      // persisted on the session.
      await page.goto("/medications");
      await toggleIntoView(page, wardId, 3);
      await page.goto("/medications");

      const strip = page.getByTestId("med-today-everyone");
      await expect(strip).toBeVisible();
      const wardRow = strip.getByTestId(`med-everyone-${wardId}`);
      const roRow = strip.getByTestId(`med-everyone-${roId}`);

      // THE PAIR, in one render. The read-only member's row keeps the jump link it
      // always had and grows no control; asserted BESIDE the writable member's, so an
      // absence here means the grant rather than a strip that renders no controls at
      // all — which is the tree a lone absence assertion also passes on.
      await expect(roRow.getByTestId("med-everyone-due")).toBeVisible();
      await expect(roRow.getByTestId("dose-status")).toHaveCount(0);
      const take = wardRow.getByTestId("dose-take");
      await expect(take).toBeVisible();

      await settledClick(page, take);

      // THE WRITE FOLLOWED THE ROW, NOT THE SESSION — the whole of the capability, and
      // the half a same-profile take could never show. The ward's own board reads taken
      // while the acting profile's identically-shaped row does not, so a control that
      // had silently posted the acting profile would fail here rather than pass by
      // landing somewhere plausible.
      await expect(
        page.getByTestId(`med-board-${wardId}`).getByTestId("dose-take")
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByTestId(`med-board-${selfId}`).getByTestId("dose-take")
      ).toHaveAttribute("aria-pressed", "false");

      // AND THE WARD'S OWN MEDICATION PAGE OFFERS THE SAME TAP (#4429's second mount).
      // That page is a subject-scoped container reached WITHOUT switching — the actor
      // is unchanged, the banner names the ward — and until now its Today row was the
      // read-only receipt whatever the grant said. The take above is what it reads back,
      // which is the two mounts agreeing about one dose rather than two claims.
      await page.goto(`/medications/${wardMedId}`);
      await expect(
        page.getByTestId("medication-identity-banner")
      ).toBeVisible();
      await expect(page.getByTestId("profile-identity-bar")).toHaveAttribute(
        "data-acting-profile-id",
        String(selfId)
      );
      await expect(page.getByTestId("scheduled-dose-readonly")).toHaveCount(0);
      await expect(page.getByTestId("dose-take")).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    } finally {
      await page.context().close();
    }
  });
});

// Multi-view Clinical results table (issue #1331). The results table becomes a
// MERGE of per-(profile, family) partitions when several profiles are in view:
// is_latest/dedup are per member (a shared "Vitamin D" family never crosses), rows
// are subject-stamped, and the read-only member's rows show no edit/delete. Spec-OWNED
// fixture (E2E_LOGIN_MVBIO granted a WRITE base profile + a READ-ONLY second profile,
// each with a shared + a unique analyte — see e2e/seed-events.ts). Read-only in this
// spec (only reads + toggles the view-set), so it never races a neighbor and stays
// repeat-safe. Fresh cookie-less context (loginAs) so it drives the member's own session.
test.describe("Multi-view Clinical results table (issue #1331)", () => {
  function mvBioIds(): { selfId: number; roId: number } {
    const dbPath = workerDbPath();
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
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${id}`));
    await expectInView(page, 2);
  }

  test("single-view stays plain, then multi-view merges both members without granting writes", async ({
    browser,
  }) => {
    test.slow();
    const { roId } = mvBioIds();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MVBIO,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/results/clinical-results");
      await expect(page.getByTestId("results-clinical-results")).toBeVisible();
      await expect(
        page.getByText(MVBIO_SELF_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", { name: "Profile" })
      ).toHaveCount(0);
      await expect(page.locator('[data-testid^="subject-chip-"]')).toHaveCount(
        0
      );
      await expect(
        page.getByText(MVBIO_RO_ANALYTE, { exact: false })
      ).toHaveCount(0);

      await toggleIntoView(page, roId);
      // Re-navigation proves the selected view-set persists on the session.
      await page.goto("/results/clinical-results");
      await expectInView(page, 2);
      await expect(
        page.getByRole("columnheader", { name: "Profile" })
      ).toBeVisible();
      await expect(
        page.getByText(MVBIO_SELF_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
      ).toBeVisible();
      await expect(
        page.getByText(MVBIO_RO_ANALYTE, { exact: false }).first() // first-ok: spec-owned analyte, one row
      ).toBeVisible();
      const roChip = page.getByTestId(`subject-chip-${roId}`);
      await expect(roChip.first()).toBeVisible(); // first-ok: spec-owned RO fixture, its rows all chip

      // Both members' shared-family rows survive the per-member dedup partition.
      await page.goto("/results/clinical-results?q=vitamin+d");
      await expectInView(page, 2);
      await expect(
        page.getByRole("link", { name: MVBIO_SHARED_ANALYTE, exact: true })
      ).toHaveCount(2);

      const roRow = page.locator("tr", {
        has: page.getByTestId(`subject-chip-${roId}`),
      });
      await expect(roRow.getByTestId("overflow-menu-trigger")).toHaveCount(0);
      await expect(
        page.getByTestId("overflow-menu-trigger").first() // first-ok: acting member's own write rows
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

// Cross-profile Undo on the multi-view Clinical results table (#2104). The delete stamps
// the ROW's profile onto the capture; the restore used to resolve the ACTING profile,
// so this exact round trip — delete the non-acting member's reading, tap Undo — always
// failed ("Couldn't undo") and the capture purged for good in the retention sweep.
// Spec-OWNED fixture: the E2E_LOGIN_MULTI member holds WRITE on both of its dedicated
// profiles, and the probe reading is seeded (and swept) by name, so no shared seed row
// is counted or mutated. Fresh cookie-less context (loginAs) for the member's session.
test.describe("Cross-profile Undo round trip (#2104)", () => {
  const UNDO_PROBE_PREFIX = "MV Undo Probe";

  function multiIds(): { ownerId: number; sharedId: number } {
    const db = new Database(workerDbPath());
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

  // Sweep any probe rows (and their undo captures) a prior failed run left behind,
  // then seed THIS run's uniquely-named probe reading on the SHARED (non-acting)
  // profile. Direct SQLite with a busy timeout, like the sibling fixtures above.
  function seedProbe(sharedId: number, name: string): void {
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      db.prepare(
        `DELETE FROM medical_records WHERE name LIKE '${UNDO_PROBE_PREFIX}%'`
      ).run();
      db.prepare(
        `DELETE FROM deleted_rows
          WHERE kind = 'clinical-observation' AND payload LIKE '%${UNDO_PROBE_PREFIX}%'`
      ).run();
      db.prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num)
         VALUES (?, '2024-05-01', 'lab', ?, '42', 'ng/mL', ?, 42)`
      ).run(sharedId, name, name);
    } finally {
      db.close();
    }
  }

  test("delete the non-acting member's reading, then Undo restores it onto THAT member", async ({
    browser,
  }) => {
    test.slow();
    const { sharedId } = multiIds();
    const probeName = `${UNDO_PROBE_PREFIX} ${Date.now()}`; // clock-ok: unique probe-name suffix, not a stored timestamp
    seedProbe(sharedId, probeName);

    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Toggle the shared member into view, then open the table filtered to the probe.
    await openProfileSwitcher(page);
    await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
    await expectInView(page, 2);
    await page.goto(
      `/results/clinical-results?q=${encodeURIComponent(probeName)}`
    );
    await expectInView(page, 2);

    // The probe row renders as the SHARED member's (subject chip) with its write menu
    // — the member holds WRITE on that profile.
    const row = page.locator("tr", {
      has: page.getByRole("link", { name: probeName, exact: true }),
    });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId(`subject-chip-${sharedId}`)).toBeVisible();

    // Delete it — the multi-view delete posts the ROW's profile_id.
    await row.getByTestId("overflow-menu-trigger").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(page.getByText("Result deleted.")).toBeVisible();
    await expect(row).toHaveCount(0);

    // Undo actually restores it — the half that was structurally dead before #2104 —
    // and it comes back as the SHARED member's row (new id, same subject).
    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId(`subject-chip-${sharedId}`)).toBeVisible();

    await page.context().close();

    // Leave the shared seed exactly as found: drop this run's probe row.
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      db.prepare("DELETE FROM medical_records WHERE name = ?").run(probeName);
    } finally {
      db.close();
    }
  });
});
