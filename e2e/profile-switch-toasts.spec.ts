import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_TOASTS,
  E2E_MEMBER_PASSWORD,
  TOAST_SWITCH_A_PROFILE,
  TOAST_SWITCH_B_PROFILE,
} from "./fixture-logins";

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
// Isolation (PR #1110 shard-3 cascade): this spec switches the ACTIVE PROFILE
// mid-test, so it runs in its OWN cookie context as a dedicated member login
// (E2E_LOGIN_TOASTS) — never the shared admin storageState. On a degraded runner a
// mid-switch failure on the shared session stranded it on a fixture profile, and 17
// later specs in the same worker saw the wrong (empty) profile's data as data-gated
// app-shell failures (run 29829296858 shard 3). An own-context login can't touch the
// shared session's server-side active profile, so a failure here contains itself.
//
// Fixtures (e2e/seed-events.ts): E2E_LOGIN_TOASTS is granted TWO dedicated profiles,
// each carrying pre-existing TERMINAL rows — a done doc, a failed doc, and a ready
// import job. Profile A (TOAST_SWITCH_A_PROFILE) sorts to the lower id, so it is the
// login's default active profile on sign-in. Switching to profile B (with its OWN
// terminal history) and back must produce ZERO toasts (the fix reseeds silently).

// Any toast surfaced by the two watchers. The bespoke ExtractionToaster shows these
// headings (same for either profile's done/failed docs); the shared toast
// (ImportJobsToaster) shows the import summary, one per profile.
const TOAST_STRINGS = [
  "Extraction complete",
  "Extraction unsuccessful",
  "e2e-toastA: readings", // profile A's ready import-job toast body ("Extracted …")
  "e2e-toastB: readings", // profile B's ready import-job toast body ("Extracted …")
];

async function expectNoToasterOutput(page: Page) {
  for (const s of TOAST_STRINGS) {
    await expect(page.getByText(s, { exact: false })).toHaveCount(0);
  }
}

test.describe("Profile switch does not replay document history as toasts (#296)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Own cookie context, own member login — never the shared admin storageState.
    page = await loginAs(browser, {
      username: E2E_LOGIN_TOASTS,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("switching profiles seeds silently — no ghost toasts", async () => {
    // Land on the app as the dedicated member, whose default active profile is A
    // (the lower-id granted profile). The first poll seeds silently, so no
    // extraction/import toasts on load.
    await page.goto("/");
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      TOAST_SWITCH_A_PROFILE
    );
    // Give the toaster's first poll room to run (idle cadence is 6s), then confirm
    // a clean baseline — no toasts from profile A's own terminal history either.
    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);

    // Switch to profile B, which has its OWN terminal document/job history. Pre-fix
    // this replayed as a toast per row; the fix reseeds silently.
    await page.getByTestId("user-menu-trigger").click();
    await settledClick(
      page,
      page
        .getByTestId("user-menu-popover")
        .getByRole("button", { name: TOAST_SWITCH_B_PROFILE })
    );
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      TOAST_SWITCH_B_PROFILE
    );

    // Wait through a full idle poll cycle so a regressed build would have toasted.
    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);

    // Switch back to profile A — its docs must not re-toast either (the "switching
    // back replays the spam for A" half of the bug).
    await page.getByTestId("user-menu-trigger").click();
    await settledClick(
      page,
      page
        .getByTestId("user-menu-popover")
        .getByRole("button", { name: TOAST_SWITCH_A_PROFILE })
    );
    await expect(page.getByTestId("user-menu-trigger")).toContainText(
      TOAST_SWITCH_A_PROFILE
    );

    await page.waitForTimeout(7000);
    await expectNoToasterOutput(page);
  });
});
