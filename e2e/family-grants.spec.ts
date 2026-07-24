import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { settledCheck, settledClick } from "./helpers";
import { E2E_LOGIN_GRANTEDIT, GRANT_EDIT_PROFILE } from "./fixture-logins";

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
// storageState (the family screen is admin-only). Every mutation is driven to a
// FIXED end state (settledCheck true, level "read", own-profile → the granted
// profile), so --repeat-each replays are idempotent.

// Resolve the dedicated profile's id from the isolated e2e DB (short-lived
// connection, busy timeout) — grant-cell testids are keyed by profile id, and ids
// depend on seed order. The own-profile.spec precedent.
function grantEditProfileId(): number {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(GRANT_EDIT_PROFILE) as { id: number }
    ).id;
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
    const profileId = grantEditProfileId();
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
    // full-suite load, and "Access updated." renders only once it lands (grantSignature
    // guard #467 unchanged — the loaded snapshot still matches, so the save succeeds).
    await settledClick(
      page,
      grantRow.getByTestId(`grant-save-${E2E_LOGIN_GRANTEDIT}`)
    );
    await expect(grantRow.getByText("Access updated.")).toBeVisible({
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
    const profileId = grantEditProfileId();
    await page.goto("/settings/family");
    await expandGrantEdit(page);

    // The own-profile <select> is now inside the disclosure; its options are the
    // login's granted profiles. Point it at the granted profile — autosaves on change.
    const own = page.getByTestId(`own-profile-${E2E_LOGIN_GRANTEDIT}`);
    await expect(own).toBeVisible();
    await own.selectOption(String(profileId));
    await expect(
      page
        .getByTestId(`grant-summary-${E2E_LOGIN_GRANTEDIT}`)
        .getByText("Own profile updated.")
    ).toBeVisible({ timeout: 15_000 });

    // Persistence across a fresh load + re-expand.
    await page.goto("/settings/family");
    await expandGrantEdit(page);
    await expect(
      page.getByTestId(`own-profile-${E2E_LOGIN_GRANTEDIT}`)
    ).toHaveValue(String(profileId));
  });
});
