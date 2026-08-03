import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { switchToProfile } from "./family-helpers";
import { hydratedClick, settledClick, followLink } from "./helpers";
import { medicationsToday, scheduledTodayItem } from "./med-card-helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SUPPLY,
  SUPPLY_PARENT_PROFILE,
  SUPPLY_CHILD_PROFILE,
  SUPPLY_SHARED_BOTTLE,
  SUPPLY_PARENT_MED,
  SUPPLY_CHILD_MED,
  SUPPLY_LOW_BOTTLE,
  SUPPLY_EDIT_BOTTLE,
} from "./fixture-logins";

// Shared medication/supplement supply pools — the household medicine cabinet (#1374).
//
// Spec-owned fixtures throughout (#868): a DEDICATED caregiver login granted two
// DEDICATED profiles, each with its own medication linked to one of THREE spec-owned
// bottles (a stocked one for the decrement case, a low one for the alert case, an
// edit-only one so a rewritten count can't perturb the arithmetic elsewhere). No other
// spec reads these rows.
//
// REPEAT-SAFETY: a scheduled dose confirm is idempotent per (dose, day), so a naive
// "confirm and watch the count fall" assertion passes once and then cannot repeat under
// `--repeat-each`. Each case therefore drives the dose to a KNOWN state first
// (aria-pressed on the tri-state control) and RESTORES it afterwards — untoggling a
// confirm is the exact inverse of the decrement, so the bottle returns to where it
// started and the next repeat sees the same world.
//
// The two claims the feature exists to make:
//   1. Both members' dose confirms decrement ONE count.
//   2. A low bottle raises ONE alert for the household, not one per linked member.

const CABINET = "/supplies";

// The cabinet card for one bottle, addressed by its name (spec-owned, so unique).
function bottleCard(page: Page, name: string) {
  return page
    .getByTestId("shared-supply-card")
    .filter({ has: page.getByTestId("shared-supply-name").getByText(name) });
}

// The count the cabinet currently shows for a bottle, as a number.
async function onHand(page: Page, name: string): Promise<number> {
  const text = await bottleCard(page, name)
    .getByTestId("shared-supply-quantity")
    .innerText();
  return Number(text.replace(/[^\d.]/g, ""));
}

// Drive the named medication's Today-panel dose to `taken` (or back to clear) — the
// SAME tri-state control every other medications spec drives, so this exercises the
// real confirm path. A no-op when it already holds that state, which is what makes the
// case repeatable.
async function setDoseTaken(
  page: Page,
  medName: string,
  taken: boolean
): Promise<void> {
  await page.goto("/medications");
  const row = scheduledTodayItem(medicationsToday(page), medName);
  await expect(row).toBeVisible();
  const take = row.getByTestId("dose-take");
  if ((await take.getAttribute("aria-pressed")) === String(taken)) return;
  await settledClick(page, take);
  await expect(take).toHaveAttribute("aria-pressed", String(taken));
}

test.describe("shared supply pools", () => {
  test("two members' confirms decrement ONE shared bottle", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Start from a known, unconfirmed state for BOTH members.
      await setDoseTaken(page, SUPPLY_PARENT_MED, false);
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await setDoseTaken(page, SUPPLY_CHILD_MED, false);
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);

      // The cabinet lists the household's bottles with a POOLED projection.
      await page.goto(CABINET);
      await expect(page.getByTestId("supplies-page")).toBeVisible();
      const shared = bottleCard(page, SUPPLY_SHARED_BOTTLE);
      await expect(shared).toBeVisible();
      // Both linked members are named — this login writes both profiles.
      const members = shared.getByTestId("shared-supply-members");
      await expect(members).toContainText(SUPPLY_PARENT_MED);
      await expect(members).toContainText(SUPPLY_CHILD_MED);
      const parentItemLink = members.getByRole("link", {
        name: `Open ${SUPPLY_PARENT_MED} for ${SUPPLY_PARENT_PROFILE}`,
      });
      await expect(parentItemLink).toHaveAttribute(
        "href",
        /^\/medications\/\d+$/
      );
      const childItemLink = members.getByRole("button", {
        name: `Switch to ${SUPPLY_CHILD_PROFILE} and open ${SUPPLY_CHILD_MED}`,
      });
      await expect(childItemLink).toBeVisible();
      // Days-left says "across everyone" — the whole point of pooling.
      await expect(shared.getByTestId("shared-supply-days")).toContainText(
        "across everyone"
      );

      const before = await onHand(page, SUPPLY_SHARED_BOTTLE);

      // The parent (the acting profile) confirms their dose.
      await setDoseTaken(page, SUPPLY_PARENT_MED, true);
      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before - 1);

      // The member's own medication row shows the SHARED chip, not a private badge.
      await page.goto("/medications");
      const ownChip = page.getByTestId("shared-supply-chip").first(); // first-ok: spec-owned profile whose only tracked meds are this fixture's linked set
      await expect(ownChip).toContainText("Shared");

      // Switch to the CHILD and confirm theirs — the SAME bottle falls again.
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await setDoseTaken(page, SUPPLY_CHILD_MED, true);
      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before - 2);

      // Untoggling is the exact inverse — the bottle returns to where it started,
      // which is also what makes this case repeatable.
      await setDoseTaken(page, SUPPLY_CHILD_MED, false);
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await setDoseTaken(page, SUPPLY_PARENT_MED, false);
      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before);

      // A member item owned by another profile uses the shared explicit
      // switch-and-open chip, so its profile-owned destination cannot render
      // against the caregiver's previous acting profile.
      const restored = bottleCard(page, SUPPLY_SHARED_BOTTLE);
      await settledClick(
        page,
        restored.getByRole("button", {
          name: `Switch to ${SUPPLY_CHILD_PROFILE} and open ${SUPPLY_CHILD_MED}`,
        })
      );
      await expect(page).toHaveURL(/\/medications\/\d+$/);
      await expect(page.getByTestId("medication-subject-name")).toHaveText(
        SUPPLY_CHILD_PROFILE,
        { timeout: 15_000 }
      );
      await expect(page.getByTestId("medication-detail")).toContainText(
        SUPPLY_CHILD_MED
      );
    } finally {
      // Leave the login acting as the profile it started on.
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await page.context().close();
    }
  });

  test("a low shared bottle raises ONE alert, not one per linked member", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(CABINET);
      const low = bottleCard(page, SUPPLY_LOW_BOTTLE);
      await expect(low.getByTestId("shared-supply-low")).toBeVisible();

      // Upcoming carries exactly ONE pooled low-supply row for this bottle, even
      // though TWO of the household's medications draw from it.
      await page.goto("/upcoming");
      await expect(
        page.getByText(SUPPLY_LOW_BOTTLE, { exact: false })
      ).toHaveCount(1);

      // …and the same holds acting as the OTHER linked member: one bottle, one row
      // on their surfaces too — never N rows for one bottle.
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await page.goto("/upcoming");
      await expect(
        page.getByText(SUPPLY_LOW_BOTTLE, { exact: false })
      ).toHaveCount(1);
    } finally {
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await page.context().close();
    }
  });

  // The cabinet lost its nav row in #1522 (physical registries are reached from
  // their consumers, the /equipment pattern). These are the doors that replaced it —
  // if they regress, the surface becomes unreachable except by typing the URL.
  test("the cabinet is reached from its consumer surfaces, counted (#1522)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Medications: the door sits in the page header beside "Add medication".
      await page.goto("/medications");
      const medDoor = page.getByTestId("shared-supplies-link");
      // A count, not a bare label — this login's two profiles draw from the three
      // bottles this spec owns. Asserted as a PATTERN, never an exact number: other
      // specs' bottles are orphan-visible to everyone and exact-counting shared seed
      // rows is what the fixture-hygiene rule forbids.
      await expect(medDoor).toHaveText(/\d+ shared bottles/);
      await expect(
        medDoor.getByTestId("shared-supplies-chevron")
      ).toBeVisible();
      // The accessible name keeps the destination's NAME even when the visible label
      // is a count, so the link never reads as an anonymous number to AT.
      await expect(medDoor).toHaveAttribute("aria-label", /Medicine cabinet/);
      await followLink(page, medDoor, new RegExp(`${CABINET}$`));
      await expect(page.getByTestId("supplies-page")).toBeVisible();

      // Nutrition → Supplements: the same door lives in the tab's right-hand
      // management sidebar (the header's action slot is shared with Food).
      await page.goto("/nutrition?tab=supplements");
      const supplementDoor = page.getByTestId("shared-supplies-link");
      await expect(supplementDoor).toBeVisible();
      expect(
        await supplementDoor.evaluate((node) => {
          const sidebar = document.querySelector(
            '[data-testid="supplement-sidebar"]'
          );
          return Boolean(sidebar?.contains(node));
        })
      ).toBe(true);
      await followLink(page, supplementDoor, new RegExp(`${CABINET}$`));

      // Household: the cabinet is a household-scoped surface, so its door lives
      // beside History in that header.
      await page.goto("/household");
      await followLink(
        page,
        page.getByTestId("shared-supplies-link"),
        new RegExp(`${CABINET}$`)
      );
    } finally {
      await page.context().close();
    }
  });

  test("the cabinet edits a bottle and is reachable from a medication chip", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // A linked medication's shared chip deep-links to the cabinet.
      await page.goto("/medications");
      const chip = page.getByTestId("shared-supply-chip").first(); // first-ok: spec-owned profile; every tracked med here is this fixture's and every chip targets the cabinet
      await followLink(page, chip, new RegExp(`${CABINET}$`));

      // Edit THIS case's own bottle through the cabinet form (explicit submit, and it
      // round-trips the loaded value for the #467 pool-level compare-and-set). Writing
      // an absolute value is idempotent, so the case repeats cleanly.
      await expect(page.getByTestId("supplies-page")).toHaveClass(
        /\bmx-auto\b/
      );
      const editable = bottleCard(page, SUPPLY_EDIT_BOTTLE);
      // The overflow trigger and its Edit item are onClick-only client state
      // (SharedSupplyCard) — the qty input the Edit reveals is the signal.
      await hydratedClick(
        page,
        editable.getByRole("button", {
          name: `${SUPPLY_EDIT_BOTTLE} bottle actions`,
        })
      );
      await hydratedClick(page, page.getByTestId("shared-supply-edit"));
      await expect(
        editable.getByTestId("shared-supply-qty-input")
      ).toBeVisible();
      await editable.getByTestId("shared-supply-qty-input").fill("123");
      const save = editable.getByTestId("shared-supply-save");
      await expect(save).toHaveClass(/\bbtn\b/);
      await expect(save).not.toHaveClass(/\bbtn-primary\b/);
      await settledClick(page, save);
      await expect(async () => {
        expect(await onHand(page, SUPPLY_EDIT_BOTTLE)).toBe(123);
      }).toPass(); // topass-ok: awaits the revalidated cabinet after the explicit save

      // Both actions live in the card's standard overflow. Delete opens the
      // app-wide confirmation sheet rather than expanding bespoke controls into
      // the edit form; cancel it so this fixture remains repeat-safe.
      await hydratedClick(
        page,
        editable.getByRole("button", {
          name: `${SUPPLY_EDIT_BOTTLE} bottle actions`,
        })
      );
      // Delete only opens the confirm sheet (a promise, not a write) — the
      // dialog asserted immediately below is the signal.
      await hydratedClick(page, page.getByTestId("shared-supply-delete"));
      const dialog = page.getByTestId("confirm-dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("Delete bottle", { exact: true })
      ).toBeVisible();
      await expect(dialog).toContainText(`Delete “${SUPPLY_EDIT_BOTTLE}”?`);
      await expect(
        dialog.getByRole("button", { name: "Delete", exact: true })
      ).toHaveClass(/\bbtn-danger\b/);
      // Cancel resolves the confirm with false: nothing is written, so there is
      // no POST — the dialog's disappearance is the signal.
      await hydratedClick(
        page,
        dialog.getByRole("button", { name: "Cancel", exact: true })
      );
      await expect(dialog).not.toBeVisible();
      await expect(editable).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
