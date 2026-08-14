import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { type Page } from "@playwright/test";
import { hydratedClick, settledCheck, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_GRANTEDIT,
  E2E_LOGIN_NOTIFY_SCOPE,
  E2E_MEMBER_PASSWORD,
  GRANT_EDIT_PROFILE,
  NOTIFY_SCOPE_OWN_PROFILE,
  NOTIFY_SCOPE_WARD_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The admin notification opt-in (#2345), in a browser.
//
// The fan-out excludes the admin ROLE on purpose and says an admin opts specific
// profiles back in by granting themselves — but Settings → Family refused every
// admin, so the opt-in was unperformable and a single-admin instance delivered
// nothing about anyone but the admin's own profile. What only a browser can prove is
// that the CONTROL now exists, says what it does, and exists on BOTH surfaces:
// Family (admin-only, about other people's logins) is not where someone goes to
// change what buzzes their own phone.
//
// Other tiers own the rest: the write + the fan-out consequence
// (lib/__action_tests__/grants.actions.test.ts, lib/__db_tests__/admin-notify-optin.test.ts),
// the inertness of an admin's row for ACCESS (lib/__db_tests__/auth.test.ts), and the
// stored-level decision (lib/__tests__/grants.test.ts).
//
// Spec-OWNED fixture: E2E_LOGIN_NOTIFY_SCOPE, its own ADMIN login with its own two
// profiles. It must not be the shared admin storageState — the rows this spec writes
// decide who the fan-out reaches, so enrolling the storageState admin would make
// every other spec's session a notification recipient.

function fixtureIds(): {
  ownId: number;
  wardId: number;
  grantEditId: number;
} {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const idOf = (name: string) =>
      (
        db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id;
    return {
      ownId: idOf(NOTIFY_SCOPE_OWN_PROFILE),
      wardId: idOf(NOTIFY_SCOPE_WARD_PROFILE),
      grantEditId: idOf(GRANT_EDIT_PROFILE),
    };
  } finally {
    db.close();
  }
}

// Open a login's collapsed grant disclosure past the pre-hydration toggle swallow
// (#830): Edit is a pure client setState with no Server Action to settle on, so a
// tap lost before React attaches `onClick` is lost for good.
//
// hydratedClick, not a re-click loop (#2729) — the same repair and the same measured
// reason as family-grants' expandGrantEdit, which carries the numbers: the old loop
// spent its ceiling on pre-hydration clicks that could not land, so waiting for the
// hydration marker is what converges. Idempotent by inspection (an already-open body
// is left alone), never by re-clicking — `setOpen((v) => !v)` is a real toggle, so a
// retry stays a hazard even where it was not the observed failure.
async function expandLogin(
  page: Page,
  username: string,
  bodyTestId: string
): Promise<void> {
  const summary = page.getByTestId(`grant-summary-${username}`);
  await expect(summary).toBeVisible();
  const body = page.getByTestId(bodyTestId);
  if (await body.isVisible()) return;
  await hydratedClick(page, summary.getByTestId(`grant-edit-${username}`), {
    timeout: 20_000,
  });
  await expect(body).toBeVisible({ timeout: 20_000 });
}

test.describe("Settings → Family tells access and notifications apart (#2345)", () => {
  test("a member gets the access matrix; an admin gets a notification checklist", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the family route on first hit
    const { ownId, wardId, grantEditId } = fixtureIds();
    await page.goto("/settings/family");

    // A MEMBER is unchanged: their row IS their access, so it keeps the read/write
    // level selector — and offers no notification control of its own.
    await expandLogin(
      page,
      E2E_LOGIN_GRANTEDIT,
      `grant-row-${E2E_LOGIN_GRANTEDIT}`
    );
    const memberRow = page.getByTestId(`grant-row-${E2E_LOGIN_GRANTEDIT}`);
    await expect(memberRow).toContainText(GRANT_EDIT_PROFILE);
    await expect(
      memberRow.getByTestId(
        `grant-access-${E2E_LOGIN_GRANTEDIT}-${grantEditId}`
      )
    ).toBeVisible();
    await expect(
      page.getByTestId(`notify-scope-${E2E_LOGIN_GRANTEDIT}`)
    ).toHaveCount(0);

    // An ADMIN gets the opt-in instead, under its own heading, saying what it does.
    await expandLogin(
      page,
      E2E_LOGIN_NOTIFY_SCOPE,
      `notify-scope-${E2E_LOGIN_NOTIFY_SCOPE}`
    );
    const adminEditor = page.getByTestId(
      `notify-scope-${E2E_LOGIN_NOTIFY_SCOPE}`
    );
    await expect(adminEditor).toBeVisible();
    await expect(adminEditor).toContainText("Notifications");
    await expect(adminEditor).toContainText("can already see every profile");
    // No access level anywhere in it — a selector here would change nothing, and
    // saying otherwise is the confusion this issue is about.
    await expect(adminEditor.locator("select")).toHaveCount(0);
    await expect(
      adminEditor.getByTestId(
        `grant-access-${E2E_LOGIN_NOTIFY_SCOPE}-${wardId}`
      )
    ).toHaveCount(0);

    // The admin's OWN profile is on and NOT toggleable — it is already in the
    // recipient set through own_profile_id, so a checkbox that appeared to turn it
    // off would be a lying control. It says why, in words, visibly.
    const ownToggle = adminEditor.getByTestId(
      `notify-scope-toggle-${E2E_LOGIN_NOTIFY_SCOPE}-${ownId}`
    );
    await expect(ownToggle).toBeVisible();
    await expect(ownToggle).toBeChecked();
    await expect(ownToggle).toBeDisabled();
    const ownNote = adminEditor.getByTestId(
      `notify-scope-own-${E2E_LOGIN_NOTIFY_SCOPE}-${ownId}`
    );
    await expect(ownNote).toBeVisible();
    await expect(ownNote).toHaveText("their own profile");

    // Every other profile IS toggleable — that is the opt-in.
    const wardToggle = adminEditor.getByTestId(
      `notify-scope-toggle-${E2E_LOGIN_NOTIFY_SCOPE}-${wardId}`
    );
    await expect(wardToggle).toBeVisible();
    await expect(wardToggle).toBeEnabled();
  });
});

test.describe("Settings → Notifications carries the same control (#2345)", () => {
  test("the signed-in admin opts a profile in, and Family shows it", async ({
    page,
    browser,
  }) => {
    test.slow();
    const { ownId, wardId } = fixtureIds();
    const admin = await loginAs(browser, {
      username: E2E_LOGIN_NOTIFY_SCOPE,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await admin.goto("/settings/notifications");

      // The same control, scoped to self — on the login-scoped delivery surface the
      // person actually goes to. An opt-in that only exists where they are not sent
      // is not an opt-in.
      const section = admin.getByTestId("notify-scope-section");
      await expect(section).toBeVisible();
      await expect(section).toContainText("reach your channels");
      const editor = section.getByTestId(
        `notify-scope-${E2E_LOGIN_NOTIFY_SCOPE}`
      );
      await expect(editor).toBeVisible();

      // Same locked-on own row, phrased for the reader whose profile it is.
      const ownNote = editor.getByTestId(
        `notify-scope-own-${E2E_LOGIN_NOTIFY_SCOPE}-${ownId}`
      );
      await expect(ownNote).toBeVisible();
      await expect(ownNote).toHaveText("your own profile");
      await expect(
        editor.getByTestId(
          `notify-scope-toggle-${E2E_LOGIN_NOTIFY_SCOPE}-${ownId}`
        )
      ).toBeDisabled();

      // Opt the ward in. Driven to a FIXED end state (checked) so a --repeat-each
      // replay is deterministic: settledCheck is idempotent, and on a replay the
      // desired set already matches, so the action short-circuits to "No changes." —
      // both are green, and the Family read below is the durable proof.
      await settledCheck(
        admin,
        editor.getByTestId(
          `notify-scope-toggle-${E2E_LOGIN_NOTIFY_SCOPE}-${wardId}`
        ),
        true
      );
      await settledClick(
        admin,
        editor.getByTestId(`notify-scope-save-${E2E_LOGIN_NOTIFY_SCOPE}`)
      );
      const msg = editor.getByTestId(
        `notify-scope-msg-${E2E_LOGIN_NOTIFY_SCOPE}`
      );
      await expect(msg).toBeVisible({ timeout: 15_000 });
      await expect(msg).toHaveText(/Notifications updated\.|No changes\./);
    } finally {
      await admin.context().close();
    }

    // ONE action, two renderers: the Family page (a different login, a different
    // context) shows the same row checked — same storage, not a second setting.
    await page.goto("/settings/family");
    await expandLogin(
      page,
      E2E_LOGIN_NOTIFY_SCOPE,
      `notify-scope-${E2E_LOGIN_NOTIFY_SCOPE}`
    );
    const familyWard = page
      .getByTestId(`notify-scope-${E2E_LOGIN_NOTIFY_SCOPE}`)
      .getByTestId(`notify-scope-toggle-${E2E_LOGIN_NOTIFY_SCOPE}-${wardId}`);
    await expect(familyWard).toBeVisible();
    await expect(familyWard).toBeChecked();
  });
});
