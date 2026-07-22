import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_CRISIS,
  E2E_MEMBER_PASSWORD,
  CRISIS_OVERRIDE_CONTACT,
} from "./fixture-logins";

// #997 (mental-health visit kind + shared-surface sensitivity) and #996 (passive
// crisis-resource surface + configurable resources). Runs as E2E_LOGIN_CRISIS in its
// OWN cookie context on a dedicated adult profile whose calendar feed is seeded to
// FULL detail and carries a per-profile crisis-resources override. The spec OWNS the
// appointments it books (unique titles, filtered — never a shared-seed count), so
// --repeat-each stays clean.

const THERAPY_TITLE = "E2E therapy visit (crisis-spec)";
const PHYSICAL_TITLE = "E2E cardiology check (crisis-spec)";

async function bookVisit(page: Page, title: string, kind: string) {
  await page.goto("/records/history/visits");
  const upcoming = page.getByTestId("visits-upcoming");
  await expect(upcoming).toBeVisible();
  await upcoming.getByLabel("Reason / title").fill(title);
  await upcoming.getByLabel("Kind (optional)").selectOption(kind);
  await settledClick(
    page,
    upcoming.getByRole("button", { name: "Add", exact: true })
  );
  // Repeated runs can leave an earlier success toast visible briefly. Assert the
  // newest toast instead of making the locator strict across both messages.
  await expect(page.getByText("Appointment saved").last()).toBeVisible();
}

test.describe("mental-health visit sensitivity + crisis resources (#997/#996)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CRISIS,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("the passive crisis-resources surface renders the configured resource", async () => {
    await page.goto("/crisis-resources");
    await expect(
      page.getByRole("heading", { name: "Crisis support" })
    ).toBeVisible();
    const panel = page.getByTestId("crisis-resources");
    await expect(panel).toBeVisible();
    // The per-profile override resource shows (not the neutral fallback, not 988).
    await expect(panel).toContainText(CRISIS_OVERRIDE_CONTACT);
    await expect(panel).not.toContainText("988");
    await expect(page.getByTestId("crisis-resources-fallback")).toHaveCount(0);
  });

  test("the mental_health kind is bookable and shows its full title on the OWN Upcoming view", async () => {
    await bookVisit(page, THERAPY_TITLE, "mental_health");
    const upcoming = page.getByTestId("visits-upcoming");
    // The profile's OWN view always shows full detail — the real title, never
    // minimized. First-match (not an exact count): the spec re-books under
    // --repeat-each, so its own rows accumulate on the reused profile (#868).
    await expect(
      upcoming
        .getByTestId("appointment-row")
        .filter({ hasText: THERAPY_TITLE })
        .first() // first-ok: filtered to this spec's therapy appointment; .first() because rows accumulate under --repeat-each (see comment above)
    ).toBeVisible();
  });

  test("a mental_health visit defaults to minimal detail on the exported calendar feed", async () => {
    await bookVisit(page, PHYSICAL_TITLE, "physical");
    // The calendar-feed preview mirrors the .ics the family feed serves, at this
    // profile's FULL detail. A physical shows its real title; a mental_health visit is
    // STILL minimized to "Medical appointment" — the one kind whose default flips.
    await page.goto("/integrations/calendar-feed");
    const list = page.getByTestId("calendar-preview-list");
    await expect(list).toBeVisible();
    await expect(list.getByText(PHYSICAL_TITLE).first()).toBeVisible(); // first-ok: this spec's booked physical visit (accumulates under --repeat-each) — order-agnostic
    await expect(list.getByText(THERAPY_TITLE)).toHaveCount(0);
    await expect(list.getByText("Medical appointment").first()).toBeVisible(); // first-ok: the minimized mental_health visit label (this spec's booked visit) — order-agnostic
  });
});
