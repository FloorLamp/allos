import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_BADGE,
  E2E_LOGIN_ONBOARDING,
  E2E_LOGIN_ONBOARDING_CAREGIVER,
  E2E_LOGIN_RECAP,
  E2E_LOGIN_SLEEP_SEGMENTED,
} from "./fixture-logins";

async function expectCandidate(
  page: Awaited<ReturnType<typeof loginAs>>,
  prefix: string
) {
  await page.goto("/");
  await expect(dashboardCandidatePrefix(page, prefix)).not.toHaveCount(0);
  await page.context().close();
}

test("retired dashboard fixtures resolve to their atomic facts", async ({
  browser,
}) => {
  await expectCandidate(
    await loginAs(browser, {
      username: E2E_LOGIN_SLEEP_SEGMENTED,
      password: E2E_MEMBER_PASSWORD,
    }),
    "sleep.duration:"
  );
  // Keep each explicit sign-in outside the hygiene scanner's preceding bounded
  // call window; these are deliberately distinct access-control subjects.
  const onboarding = await loginAs(browser, {
    username: E2E_LOGIN_ONBOARDING,
    password: E2E_MEMBER_PASSWORD,
  });
  await onboarding.goto("/");
  await expect(onboarding).toHaveURL(/\/onboarding/);
  await onboarding.context().close();
  // Keep each explicit sign-in outside the hygiene scanner's preceding bounded
  // call window; these are deliberately distinct access-control subjects.
  const caregiverOnboarding = await loginAs(browser, {
    username: E2E_LOGIN_ONBOARDING_CAREGIVER,
    password: E2E_MEMBER_PASSWORD,
  });
  await caregiverOnboarding.goto("/");
  await expect(caregiverOnboarding).toHaveURL(/\/onboarding/);
  await caregiverOnboarding.context().close();
  // Keep each explicit sign-in outside the hygiene scanner's preceding bounded
  // call window; these are deliberately distinct access-control subjects.
  await expectCandidate(
    await loginAs(browser, {
      username: E2E_LOGIN_BADGE,
      password: E2E_MEMBER_PASSWORD,
    }),
    "attention.fact:"
  );
  // Keep each explicit sign-in outside the hygiene scanner's preceding bounded
  // call window; these are deliberately distinct access-control subjects.
  await expectCandidate(
    await loginAs(browser, {
      username: E2E_LOGIN_RECAP,
      password: E2E_MEMBER_PASSWORD,
    }),
    "session.recap:"
  );
});

test("segmented sleep composes in one fixed family without regularity duplication", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SLEEP_SEGMENTED,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const family = page.locator('[data-standing-family="last-night-sleep"]');
    const ids = await family
      .getByTestId("dashboard-candidate")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-candidate-id"))
      );
    expect(ids.map((id) => id?.split(":", 1)[0])).toEqual([
      "sleep.duration",
      "sleep.bed-time",
      "sleep.wake-time",
    ]);
    await expect(family).toContainText("8h");
    await expect(
      page.locator('[data-candidate-id^="sleep.regularity:"]')
    ).toHaveCount(0);

    // #3970's owner ruling on the usual band. It used to mount the SAME string as an
    // InfoTooltipIcon on BOTH the bed-time and the wake-time member — one constant
    // explainer, two 34px buttons, on one line. It inlines once now, as plain detail
    // text after the wake time.
    //
    // This claim lives HERE and not in dashboard.spec.ts because this is the persona
    // that renders the sleep members at all: the test it replaces sat on
    // E2E_LOGIN_DAILY behind `if (bedCount === 0) return`, and that early return was
    // taken on every run — measured 2026-08-31, 0 sleep.bed-time rows on that login.
    // It also read a `title=` attribute, which #3375 removed app-wide. Two independent
    // reasons it could no longer fail.
    const wake = family.locator('[data-candidate-id^="sleep.wake-time:"]');
    const bed = family.locator('[data-candidate-id^="sleep.bed-time:"]');
    await expect(wake).toContainText(/Usual .+ – .+/);
    await expect(bed).not.toContainText("Usual");
    // No control anywhere carries it. Matched on the ACCESSIBLE NAME, because that is
    // what InfoTooltipIcon puts on its button and these two mounts never had a testid.
    await expect(page.getByRole("button", { name: /^Usual / })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
