import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick, expectInView } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_MULTI,
  MULTI_OWNER_PROFILE,
  MULTI_SHARED_PROFILE,
  MULTI_SHARED_DENTAL,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Records › Specialty adopts multi-view (issue #2557).
//
// Two things are under test and they are the same decision seen from both sides:
//
//   1. The PANE GATE follows the VIEW. Dental and Vision are data-gated, and the
//      fixture puts their rows on the SHARED member only — so acting alone the owner
//      is redirected away and the sub-tab is absent, and toggling the shared member
//      into view makes both panes reachable. Gating on the acting profile would have
//      denied a pane that was about to list a row.
//   2. The LISTED ROW is honest about whose it is. The shared member's record carries
//      its subject chip, and the acting profile's rows never do.
//
// Spec-OWNED fixtures (E2E_LOGIN_MULTI's two profiles). The owner's half of the
// fixture is an ABSENCE, so the spec establishes it rather than assuming it — another
// spec sharing this worker DB may legitimately have written a dental or optical row.
// Read-only viewing plus the per-session view-set, so there is no persistent write to
// undo afterwards.

function specialtyFixture(): { ownerId: number; sharedId: number } {
  const db = new Database(workerDbPath());
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
    // Establish the owner's absence: the whole point of the fixture is that the
    // acting profile has NO dental record and NO prescription of its own.
    db.prepare("DELETE FROM dental_procedures WHERE profile_id = ?").run(
      ownerId
    );
    db.prepare("DELETE FROM optical_prescriptions WHERE profile_id = ?").run(
      ownerId
    );
    return { ownerId, sharedId };
  } finally {
    db.close();
  }
}

async function enterMultiView(
  page: Awaited<ReturnType<typeof loginAs>>,
  sharedId: number
): Promise<void> {
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
  await settledClick(page, page.getByTestId(`view-toggle-${sharedId}`));
  await expectInView(page, 2);
}

test.describe("Records › Specialty adopts multi-view (issue #2557)", () => {
  test("Dental: hidden and unreachable acting alone; reachable and subject-chipped once the member with rows is in view", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = specialtyFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    // Single view: the acting profile has no dental rows, so the pane is gated —
    // the sub-tab is absent and a direct hit bounces to the first visible pane.
    await page.goto("/records/specialty/hearing");
    await expectInView(page, 1);
    await expect(
      page.getByTestId("records-sub-tabs").getByRole("link", { name: "Dental" })
    ).toHaveCount(0);
    await page.goto("/records/specialty/dental");
    await expect(page).not.toHaveURL(/\/records\/specialty\/dental$/);
    await expect(page.getByTestId("records-dental")).toHaveCount(0);

    await enterMultiView(page, sharedId);

    // Multi view: the shared member HAS dental rows, so the pane is now reachable —
    // and its sub-tab is back, because the strip asks the same question the route does.
    await expect(
      page.getByTestId("records-sub-tabs").getByRole("link", { name: "Dental" })
    ).toBeVisible();
    await page.goto("/records/specialty/dental");
    await expect(page.getByTestId("records-dental")).toBeVisible();

    // The listed row belongs to the shared member and says so; the acting profile's
    // rows never carry a chip.
    const sharedRow = page
      .locator("tr")
      .filter({ hasText: MULTI_SHARED_DENTAL });
    await expect(sharedRow).toBeVisible();
    await expect(
      sharedRow.getByTestId(`subject-chip-${sharedId}`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);
    // Recheck stays an ACTING-profile feature (the #1328 scope-limit): the shared
    // member's row offers no track control, because tracking one would write the
    // actor's care plan about someone else's tooth.
    await expect(
      sharedRow.locator('[data-testid^="track-dental-followup-"]')
    ).toHaveCount(0);

    await page.context().close();
  });

  test("Vision: same gate, and the shared prescription row carries its subject chip", async ({
    browser,
  }) => {
    test.slow();
    const { ownerId, sharedId } = specialtyFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/records/specialty/vision");
    await expect(page).not.toHaveURL(/\/records\/specialty\/vision$/);
    await expect(page.getByTestId("records-vision")).toHaveCount(0);

    await enterMultiView(page, sharedId);

    await page.goto("/records/specialty/vision");
    await expect(page.getByTestId("records-vision")).toBeVisible();
    // The table renders the Rx by kind and per-eye powers, not by brand, so the row is
    // identified by the list it lives in: the owner's prescriptions were removed above,
    // so every row this list can show belongs to the shared member.
    const list = page.getByTestId("optical-prescription-list");
    await expect(list.getByTestId(`subject-chip-${sharedId}`)).toBeVisible();
    await expect(
      list.locator(`[data-testid="subject-chip-${ownerId}"]`)
    ).toHaveCount(0);

    await page.context().close();
  });
});
