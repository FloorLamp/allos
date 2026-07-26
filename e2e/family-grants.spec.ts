import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledCheck, settledClick } from "./helpers";
import { E2E_LOGIN_GRANTEDIT, GRANT_EDIT_PROFILE } from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Family grant-matrix collapse (issue #1412). Settings → Family used to eagerly
// render O(logins × profiles) grant controls (measured ~8,281 controls / 5 MB HTML
// at fixture scale — the #830/#1111/#1392 e2e census root cause). GrantsCard now
// renders one COLLAPSED summary row per login (username · role · "N of M profiles")
// and mounts a login's per-profile grant toggles + own-profile <select> only when
// its Edit disclosure is opened — O(logins) at rest.
//
// Spec-OWNED fixture: E2E_LOGIN_GRANTEDIT, a dedicated member granted ONE dedicated
// profile (GRANT_EDIT_PROFILE), nobody else's dependency — so flipping its grant
// level / own-profile here can't perturb another spec. Driven as the shared ADMIN
// storageState (the family screen is admin-only). Grant edits are driven to a FIXED
// end state (settledCheck true, level "read") and the own-profile edit always flips to
// a value DIFFERENT from the login's current one (read from the DB), so --repeat-each
// replays stay deterministic.

// Resolve the dedicated profile's id AND the login's current own_profile_id from the
// isolated e2e DB (short-lived connection, busy timeout). grant-cell testids are keyed
// by profile id (seed-order-dependent), and the own-profile test reads the CURRENT
// own_profile_id so it can always change it to a DIFFERENT value — a controlled
// <select>'s onChange (the autosave) fires only on a real change, so re-selecting the
// value it already holds (on a --repeat-each replay) would be a silent no-op. The
// own-profile.spec precedent for the DB read.
function grantEditFixture(): {
  profileId: number;
  ownProfileId: number | null;
} {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const profileId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(GRANT_EDIT_PROFILE) as { id: number }
    ).id;
    const ownProfileId = (
      db
        .prepare("SELECT own_profile_id AS o FROM logins WHERE username = ?")
        .get(E2E_LOGIN_GRANTEDIT) as { o: number | null }
    ).o;
    return { profileId, ownProfileId };
  } finally {
    db.close();
  }
}

// Open the grant-edit login's disclosure past the pre-hydration toggle swallow
// (#830): the Edit button is a pure client setState (no Server Action to settle on),
// so re-click until the lazily-mounted grant grid renders. Idempotent — a swallowed
// click is a no-op, and once the grid is visible the loop stops clicking (so it never
// double-toggles back to collapsed).
async function expandGrantEdit(page: Page): Promise<void> {
  const summary = page.getByTestId(`grant-summary-${E2E_LOGIN_GRANTEDIT}`);
  await expect(summary).toBeVisible();
  const editBtn = summary.getByTestId(`grant-edit-${E2E_LOGIN_GRANTEDIT}`);
  const grantRow = page.getByTestId(`grant-row-${E2E_LOGIN_GRANTEDIT}`);
  await expect(async () => {
    if (!(await grantRow.isVisible())) await editBtn.click().catch(() => {});
    await expect(grantRow).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 }); // topass-ok: pre-hydration disclosure toggle swallow (#830), no POST to settle on — re-click until the lazily-mounted grid renders (idempotent)
}

test.describe("Family grant matrix collapses to summary rows (#1412)", () => {
  test("collapsed rows show 'N of M profiles' and mount ZERO grant controls at rest", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the family route on first hit
    await page.goto("/settings/family");

    // The member's collapsed summary row + its "N of M profiles" line.
    const summary = page.getByTestId(`grant-summary-${E2E_LOGIN_GRANTEDIT}`);
    await expect(summary).toBeVisible();
    await expect(
      summary.getByTestId(`grant-count-${E2E_LOGIN_GRANTEDIT}`)
    ).toHaveText(/\d+ of \d+ profiles/);

    // Perf regression guard: with every login collapsed, NO per-profile grant toggle
    // and NO grant grid is mounted anywhere on the card — regardless of how many
    // profiles the seeded population carries. This is the census fix working: the page
    // is O(logins), not O(logins × profiles).
    await expect(page.getByTestId(/^grant-toggle-/)).toHaveCount(0);
    await expect(page.locator('[data-testid^="grant-row-"]')).toHaveCount(0);
  });

  test("expanding one login mounts its controls; a grant level change persists", async ({
    page,
  }) => {
    test.slow();
    const { profileId } = grantEditFixture();
    await page.goto("/settings/family");
    await expandGrantEdit(page);

    const grantRow = page.getByTestId(`grant-row-${E2E_LOGIN_GRANTEDIT}`);
    const toggle = grantRow.getByTestId(
      `grant-toggle-${E2E_LOGIN_GRANTEDIT}-${profileId}`
    );
    // Ensure the grant is on (idempotent) and set its level to read-only.
    await settledCheck(page, toggle, true);
    await grantRow
      .getByTestId(`grant-access-${E2E_LOGIN_GRANTEDIT}-${profileId}`)
      .selectOption("read");
    // settledClick + a widened banner timeout: the save races the setGrants POST under
    // full-suite load, and the banner renders only once it lands (grantSignature guard
    // #467 unchanged — the loaded snapshot still matches, so the save succeeds). On the
    // FIRST run the level flips write→read → "Access updated."; on a --repeat-each replay
    // the level is already read → setGrants short-circuits to "No changes." — both are
    // green success banners, and the reload check below is the durable persistence proof.
    await settledClick(
      page,
      grantRow.getByTestId(`grant-save-${E2E_LOGIN_GRANTEDIT}`)
    );
    await expect(
      grantRow.getByText(/Access updated\.|No changes\./)
    ).toBeVisible({
      timeout: 15_000,
    });

    // Persistence: a fresh load collapses the grid again; re-expanding shows the level
    // held at read-only (proves setGrants persisted, not just client state).
    await page.goto("/settings/family");
    await expandGrantEdit(page);
    await expect(
      page.getByTestId(`grant-access-${E2E_LOGIN_GRANTEDIT}-${profileId}`)
    ).toHaveValue("read");
  });

  test("the own-profile select autosaves for the expanded login (#1013, lazily mounted)", async ({
    page,
  }) => {
    test.slow();
    const { profileId, ownProfileId } = grantEditFixture();
    // Always change to a DIFFERENT value than the login currently holds, so the
    // controlled <select>'s onChange (the autosave) fires on every run: none↔the
    // granted profile. The reachable options are the login's granted profiles, so the
    // granted profile is always selectable.
    const target = ownProfileId === profileId ? "none" : String(profileId);
    await page.goto("/settings/family");
    await expandGrantEdit(page);

    // The own-profile <select> is now inside the disclosure (lazily mounted, #1013).
    // Selecting a new value autosaves — no Save button.
    const own = page.getByTestId(`own-profile-${E2E_LOGIN_GRANTEDIT}`);
    await expect(own).toBeVisible();
    await own.selectOption(target);
    await expect(
      page
        .getByTestId(`grant-summary-${E2E_LOGIN_GRANTEDIT}`)
        .getByText("Own profile updated.")
    ).toBeVisible({ timeout: 15_000 });

    // Persistence across a fresh load + re-expand — proves the autosave hit the DB.
    await page.goto("/settings/family");
    await expandGrantEdit(page);
    await expect(
      page.getByTestId(`own-profile-${E2E_LOGIN_GRANTEDIT}`)
    ).toHaveValue(target);
  });
});
