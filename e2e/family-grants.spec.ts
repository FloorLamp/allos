import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick, settledCheck, settledClick } from "./helpers";
import { createLoginViaFamily } from "./family-helpers";
import {
  DUP_ACCESS_PROFILE,
  E2E_LOGIN_GRANTEDIT,
  GRANT_EDIT_PROFILE,
} from "./fixture-logins";
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

// The two DELIBERATELY same-named fixture profiles (#1434). Their ids key the
// grant-cell testids, and their id ORDER is the order the #534 disambiguation
// ordinals follow, so the spec can assert "(1)" then "(2)" against real rows.
function duplicateProfileIds(): number[] {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare("SELECT id FROM profiles WHERE name = ? ORDER BY id")
        .all(DUP_ACCESS_PROFILE) as { id: number }[]
    ).map((r) => r.id);
  } finally {
    db.close();
  }
}

// Live session rows for a login — the #1434 proof that a grantless sign-in mints
// NOTHING (the dead end used to leave "2 active sessions" on an unusable login).
function sessionCountFor(username: string): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM sessions s JOIN logins l ON l.id = s.login_id
            WHERE l.username = ?`
        )
        .get(username) as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

async function cookielessPage(browser: Browser) {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  return ctx.newPage();
}

// Open the grant-edit login's disclosure past the pre-hydration toggle swallow
// (#830): the Edit button is a pure client setState with no Server Action to settle
// on, so a tap lost before React attaches `onClick` is lost for good.
//
// hydratedClick, not a re-click loop (#2729). Measured under a 60× CDP CPU throttle,
// five sequential trials, both at their shipped budgets: the loop 1/5, this 5/5.
//
// The reason is not the one the old loop's comment implied. A pre-hydration click is
// swallowed, so it changes nothing — which also means it cannot be retried into
// working, and every iteration before hydration burned the 20 s ceiling on a click
// that could not land. Given a 60 s ceiling and nothing else changed, that same loop
// passed 4/5. Its failure was the CEILING, and waiting for the hydration marker is
// what spends the budget on the state actually being waited for.
//
// The loop was ALSO unsafe in the way it explicitly denied — the button is
// `setOpen((v) => !v)`, so a landed click whose grid paints slower than the guard's
// 2 s is closed again by the next iteration — but that was never observed: a
// MutationObserver on `aria-expanded` recorded one `false → true` transition per
// trial and never a flip back. It is fixed here because it is a live hazard, not
// because it is the thing that was failing.
async function expandGrantEdit(page: Page): Promise<void> {
  const summary = page.getByTestId(`grant-summary-${E2E_LOGIN_GRANTEDIT}`);
  await expect(summary).toBeVisible();
  const grantRow = page.getByTestId(`grant-row-${E2E_LOGIN_GRANTEDIT}`);
  // Idempotent by inspection, not by re-clicking (openMeasurementGroup's shape):
  // an already-open disclosure is left alone rather than toggled shut.
  if (await grantRow.isVisible()) return;
  await hydratedClick(
    page,
    summary.getByTestId(`grant-edit-${E2E_LOGIN_GRANTEDIT}`),
    { timeout: 20_000 }
  );
  await expect(grantRow).toBeVisible({ timeout: 20_000 });
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

test.describe("Family access is legible and never a dead end (#1434)", () => {
  test("same-named profiles are disambiguated in the matrix AND the create picker", async ({
    page,
  }) => {
    test.slow();
    const [firstDup, secondDup] = duplicateProfileIds();
    expect(
      secondDup,
      "two same-named fixture profiles are seeded"
    ).toBeTruthy();

    await page.goto("/settings/family");

    // The create-login access picker (#1434 part B) offers every profile — with the
    // #534 ordinals, so the admin can tell the two "Dup Access (e2e)" people apart
    // BEFORE granting one of them a stranger's record.
    const picker = page.getByTestId("create-access");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(`${DUP_ACCESS_PROFILE} (1)`);
    await expect(picker).toContainText(`${DUP_ACCESS_PROFILE} (2)`);

    // Same rule in the grant matrix, where granting the wrong one is costliest.
    await expandGrantEdit(page);
    const grantRow = page.getByTestId(`grant-row-${E2E_LOGIN_GRANTEDIT}`);
    await expect(
      grantRow.getByTestId(`grant-cell-${E2E_LOGIN_GRANTEDIT}-${firstDup}`)
    ).toContainText(`${DUP_ACCESS_PROFILE} (1)`);
    await expect(
      grantRow.getByTestId(`grant-cell-${E2E_LOGIN_GRANTEDIT}-${secondDup}`)
    ).toContainText(`${DUP_ACCESS_PROFILE} (2)`);
    // The grant-edit fixture profile has a unique name, so it stays untouched.
    await expect(grantRow).toContainText(GRANT_EDIT_PROFILE);
  });

  test("a member with no grants is badged, and signing in says so instead of bouncing", async ({
    page,
    browser,
  }) => {
    test.slow();
    // Spec-owned, per-run-unique login created through the real form with NO profile
    // selected — the exact login the happy path used to produce silently.
    const { username, password } = await createLoginViaFamily(page, {
      role: "member",
      accessProfileIds: [],
    });

    // The admin now gets a signal on the login's row (they used to get none).
    const row = page
      .getByTestId("login-row")
      .filter({ has: page.getByText(username, { exact: true }) });
    await expect(row.getByTestId("login-no-access")).toBeVisible();

    // And the person gets an honest outcome rather than an empty sign-in form.
    const anon = await cookielessPage(browser);
    await anon.goto("/login");
    await anon.fill('input[name="username"]', username);
    await anon.fill('input[name="password"]', password);
    await anon.click('button[type="submit"]');
    await expect(anon.getByTestId("login-error")).toContainText(
      "no profile access"
    );
    await expect(anon).toHaveURL(/\/login/);
    await anon.context().close();

    // No session was minted for a login that can't reach a page.
    expect(sessionCountFor(username)).toBe(0);
  });
});
