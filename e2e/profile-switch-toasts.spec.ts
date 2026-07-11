import { test, expect } from "@playwright/test";

// Issue #296: the app-wide ExtractionToaster / ImportJobsToaster poll the ACTIVE
// profile's document/job history and toast terminal transitions, seeding silently
// on the first poll so pre-existing terminal rows don't re-announce on load. But
// switching profiles doesn't remount these root-layout client components
// (router.refresh() re-renders server components; the seed ref survived), so the
// new profile's ENTIRE terminal history read as "just finished" and stacked a
// no-auto-dismiss toast per document/job. The fix threads the active profile id
// into both toasters and resets the seed on a switch, restoring first-poll
// (silent) seed semantics for the new profile.
//
// Fixtures (e2e/seed-events.ts): profile 2 ("Riley (child)" in the seeded DB)
// carries pre-existing TERMINAL rows — a done doc (e2e-p2-labs.pdf), a failed doc
// (e2e-p2-broken.txt), and a ready import job (e2e-p2: 3 readings). Before the fix,
// switching to it would toast all three; after the fix, zero.

// Any toast surfaced by the two watchers. The bespoke ExtractionToaster shows
// these headings; the shared toast (ImportJobsToaster) shows the import summary.
const TOAST_STRINGS = [
  "Extraction complete",
  "Extraction unsuccessful",
  "e2e-p2: 3 readings", // the ready import-job toast body ("Extracted …")
];

async function expectNoToasterOutput(page: import("@playwright/test").Page) {
  for (const s of TOAST_STRINGS) {
    await expect(page.getByText(s, { exact: false })).toHaveCount(0);
  }
}

test.describe("Profile switch does not replay document history as toasts (#296)", () => {
  test("switching profiles seeds silently — no ghost toasts", async ({
    page,
  }) => {
    // Land on the app as the bootstrap admin (active profile "admin", id 1). The
    // first poll seeds silently, so no extraction/import toasts on load.
    await page.goto("/");
    await expect(page.getByTestId("user-menu-trigger")).toContainText("admin");
    // Give the toaster's first poll room to run (idle cadence is 6s), then confirm
    // a clean baseline — no toasts from profile 1's own terminal history either.
    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);

    // Switch to the second profile, which has its OWN terminal document/job
    // history. Pre-fix this replayed as a toast per row; the fix reseeds silently.
    await page.getByTestId("user-menu-trigger").click();
    await page
      .getByTestId("user-menu-popover")
      .getByRole("button", { name: "Riley (child)" })
      .click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      "Riley (child)"
    );

    // Wait through a full idle poll cycle so a regressed build would have toasted.
    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);

    // Switch back to the admin profile — its docs must not re-toast either (the
    // "switching back replays the spam for A" half of the bug).
    await page.getByTestId("user-menu-trigger").click();
    await page
      .getByTestId("user-menu-popover")
      .getByRole("button", { name: "admin", exact: true })
      .click();
    await expect(page.getByTestId("user-menu-trigger")).toContainText("admin");

    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);
  });
});
