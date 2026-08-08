import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_STREAM_DECLINE,
  E2E_LOGIN_STREAM_LAPSED,
  E2E_LOGIN_STREAM_ONBOARD,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { expectNoClippedContent, settledClick } from "./helpers";

// The continuous-stream on/offboarding lifecycle (#2162), rendered.
//
// Three fixtures, three answers. What each spec is really pinning is the CONSENT
// SHAPE, because that is the part of this feature that can go quietly wrong:
//
//   • the onboarding offer is a QUESTION. Rendering it enables nothing, and only the
//     Yes tap writes the #2161 setting — a checkbox on Settings → Notifications that
//     is still unchecked afterwards is what "ignoring it enables nothing" means.
//   • declining it turns nothing off, because nothing was on. It stops the OFFER, and
//     the dismissal survives a reload.
//   • the offboarding prompt is an ANNOUNCEMENT of a reduction that already happened.
//     "Keep them ready" must leave the setting exactly as it was.
//
// None of these surfaces is a send: the offer renders on the dashboard and on the
// integrations page, both class-2 surfaces the user opened themselves.

test("the integrations page offers the bedtime reminder when a stream first delivers, and Yes writes the setting (#2162)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_STREAM_ONBOARD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The post-connect moment: the integrations surface the user is already on.
    await page.goto("/data?section=import");
    const card = page.getByTestId("stream-lifecycle-offers");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Health Connect started sending");
    await expect(card).toContainText("Off unless you turn it on");

    // Rendering the offer has enabled nothing.
    await page.goto("/settings/notifications");
    const toggle = page.getByTestId("wear-reminder-enabled");
    await expect(toggle).not.toBeChecked();

    await page.goto("/data?section=import");
    await settledClick(page, page.getByTestId("stream-offer-accept-onboard"));
    // The offer retires: a consented feature has nothing left to offer.
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);

    await page.goto("/settings/notifications");
    await expect(page.getByTestId("wear-reminder-enabled")).toBeChecked();
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});

test("the dashboard card is dismissible, enables nothing, and stays dismissed (#2162)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_STREAM_DECLINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const card = page.getByTestId("stream-lifecycle-offers");
    await expect(card).toBeVisible();
    await expect(
      page.getByTestId("stream-offer-onboard-health-connect")
    ).toBeVisible();

    await settledClick(page, page.getByTestId("stream-offer-decline-onboard"));
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);

    // Dismissed stays dismissed — the suppression bus, not a client flag.
    await page.reload();
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);

    // And declining turned NOTHING off: there was nothing on to turn off.
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("wear-reminder-enabled")).not.toBeChecked();
  } finally {
    await page.context().close();
  }
});

test("a lapsed stream shows the paused note on Settings, and Keep preserves the setting (#2162)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_STREAM_LAPSED,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Constraint 5 — setting-page honesty. The toggle is ON, and the row says the
    // send cannot fire tonight rather than implying it will.
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("wear-reminder-enabled")).toBeChecked();
    const note = page.getByTestId("kind-paused-wear-reminder");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Paused");
    await expect(note).toContainText("heart-rate");
    await expect(note).toContainText("resumes on its own");

    // The prompt explains the pause; it did not cause it.
    await page.goto("/data?section=import");
    const card = page.getByTestId("stream-lifecycle-offers");
    await expect(card).toBeVisible();
    await expect(card).toContainText("paused themselves");
    await expect(card).toContainText("nothing here has changed your setting");

    await settledClick(page, page.getByTestId("stream-offer-decline-offboard"));
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);

    // Keep leaves the consent exactly where the user put it, behind a gate that
    // reopens by itself.
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("wear-reminder-enabled")).toBeChecked();
    await expect(page.getByTestId("kind-paused-wear-reminder")).toBeVisible();
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});
