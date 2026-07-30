import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  followLink,
  settledClick,
  settledFill,
  settledSelect,
} from "./helpers";
import {
  E2E_LOGIN_LESIONALLERGY,
  E2E_MEMBER_PASSWORD,
  LESIONALLERGY_ALLERGY,
  LESIONALLERGY_ALLERGY_PICKED,
  LESIONALLERGY_ALLERGY_UNLINKED,
  LESIONALLERGY_LESION,
  LESIONALLERGY_PROVIDER,
  LESIONALLERGY_VISIT_TYPE,
} from "./fixture-logins";

// The two encounter-link gaps closed by #1526: skin_lesions and allergies were the only
// clinical observations with no link to the visit that produced them. Drives the
// dedicated LESIONALLERGY fixture — one dermatology visit with a lesion AND an allergy
// linked to it, plus an unlinked allergy for the absent-pillar contrast — so nothing here
// touches a shared-seed row.
//
// Spec-owned because the last test WRITES (it records an allergy through the form's new
// visit picker). Repeat-safe: re-adding the same substance/reaction/status collapses to
// one visible row through the existing allergy representative rule, and the newest row —
// the one carrying the link — wins, so the assertion holds on every run.
test.describe("lesion + allergy → visit links (#1526)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_LESIONALLERGY,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("an allergy row shows the visit that documented it; an unlinked one shows nothing", async () => {
    await page.goto("/records/problems/allergies");

    const linkedRow = page
      .getByRole("row")
      .filter({ hasText: LESIONALLERGY_ALLERGY });
    const recordedAt = linkedRow.getByText("Recorded at:");
    await expect(recordedAt).toBeVisible();
    await expect(recordedAt).toContainText(LESIONALLERGY_PROVIDER);
    // The visit type is a real deep-link into that visit's detail page.
    const visitLink = recordedAt
      .getByRole("link")
      .filter({ hasText: LESIONALLERGY_VISIT_TYPE });
    await expect(visitLink).toBeVisible();
    await expect(visitLink).toHaveAttribute("href", /\/encounters\/\d+/);

    // Absent pillar: the unlinked allergy carries no attribution line at all — an
    // "unknown" placeholder would be noise on the row that has nothing to say.
    const unlinkedRow = page
      .getByRole("row")
      .filter({ hasText: LESIONALLERGY_ALLERGY_UNLINKED });
    await expect(unlinkedRow).toBeVisible();
    await expect(unlinkedRow.getByText("Recorded at:")).toHaveCount(0);
  });

  test("a skin lesion shows the visit it was checked at", async () => {
    await page.goto("/records/specialty/skin");

    const card = page
      .getByTestId("lesion-card")
      .filter({ hasText: LESIONALLERGY_LESION });
    await expect(card).toBeVisible();
    const checkedAt = card.getByText("Checked at:");
    await expect(checkedAt).toBeVisible();
    await expect(
      checkedAt.getByRole("link").filter({ hasText: LESIONALLERGY_VISIT_TYPE })
    ).toBeVisible();
  });

  test("the visit's detail lists both the lesion and the allergy it produced", async () => {
    await page.goto("/records/history/visits");
    // The dedicated LESIONALLERGY fixture profile has exactly ONE visit, so this filter
    // matches only the row this spec seeded; narrowing guards the responsive
    // table-vs-card duplication of the same link, not a choice between subjects.
    const visitLinks = page
      .getByRole("link")
      .filter({ hasText: LESIONALLERGY_VISIT_TYPE });
    await followLink(
      page,
      visitLinks.first(), // first-ok: spec-owned fixture, its only visit (see above)
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-detail")).toBeVisible();

    const linked = page.getByTestId("visit-linked-rows");
    await expect(linked).toContainText("Skin lesion");
    await expect(linked).toContainText(LESIONALLERGY_LESION);
    await expect(linked).toContainText("Allergy");
    await expect(linked).toContainText(LESIONALLERGY_ALLERGY);
  });

  test("recording an allergy against a visit through the form's picker surfaces the link", async () => {
    await page.goto("/records/problems/allergies");

    await settledFill(
      page,
      page.locator("#allergy-substance-new"),
      LESIONALLERGY_ALLERGY_PICKED
    );
    await settledFill(
      page,
      page.getByTestId("allergy-reaction-new-0"),
      "swelling"
    );

    // The new picker: choose the seeded dermatology visit by its shared visit label.
    const picker = page.getByTestId("allergy-encounter-new");
    await expect(picker).toBeVisible();
    const option = picker.locator("option", {
      hasText: LESIONALLERGY_VISIT_TYPE,
    });
    const value = await option.getAttribute("value");
    expect(value).toMatch(/^\d+$/);
    await settledSelect(page, picker, value!);

    // exact: the repeatable-reactions fieldset also has an "Add reaction" button.
    await settledClick(
      page,
      page.getByRole("button", { name: "Add", exact: true })
    );

    // End state: the freshly recorded allergy reads its visit back through the SAME
    // sub-line the seeded row uses — the picker's label and the row's label are one
    // computation, so what was picked is what is read back.
    const row = page
      .getByRole("row")
      .filter({ hasText: LESIONALLERGY_ALLERGY_PICKED });
    await expect(row).toBeVisible();
    const recordedAt = row.getByText("Recorded at:");
    await expect(recordedAt).toBeVisible();
    await expect(
      recordedAt.getByRole("link").filter({ hasText: LESIONALLERGY_VISIT_TYPE })
    ).toBeVisible();
  });
});
