import { test, expect } from "@playwright/test";

// Immunization delete-confirm disambiguation (issue #534). seed-events plants two
// yellow-fever doses on the SAME date for profile 1 with distinct dose labels. The
// confirm dialog keyed on "vaccine + date" alone would read identically for both;
// the fix folds in the distinguishing dose label so the confirm names the row the
// id-keyed delete actually removes. We open the confirm and CANCEL — never mutating
// the shared fixture.
test.describe("Immunization delete confirm (#534)", () => {
  test("names the distinguishing dose for a same-vaccine same-date pair", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/immunizations");
    await expect(
      page.getByRole("heading", { name: "Immunizations" })
    ).toBeVisible();

    // The two seeded yellow-fever rows share vaccine + date but differ on dose.
    const rowA = page.getByRole("row").filter({ hasText: "Travel dose A" });
    await expect(rowA).toBeVisible();

    await rowA.getByRole("button", { name: "Delete" }).click();

    // The confirm dialog carries the distinguishing dose so it isn't ambiguous
    // against its same-vaccine same-date twin.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Yellow Fever");
    await expect(dialog).toContainText("2024-05-01");
    await expect(dialog).toContainText("Travel dose A");

    // Cancel — leave the fixture intact for other specs/runs.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
