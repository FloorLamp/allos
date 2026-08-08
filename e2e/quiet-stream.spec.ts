import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_QUIET_STREAM, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { expectNoClippedContent } from "./helpers";

// The quiet-stream row on Data → Review (#2146), rendered.
//
// The fixture is the measured off-wrist signature: Health Connect heart-rate minutes
// stopped five hours ago (past the declared 2.5 h dip tolerance), the three days
// behind today carry data, and the phone keeps recording SUCCESSFUL pushes right up
// to the frozen clock. Nothing is broken — which is precisely why no other detector
// can see it, and why the row must not borrow the language of one.
//
// The second test pins an ABSENCE, and it is the more important of the two. Heart
// rate is an observation domain, so this is coaching tier: it renders where the user
// goes looking and never becomes a send. A "remind me", "notify me" or "alert me"
// affordance appearing beside it would be the system offering to increase contact
// off the back of a passive observation — the exact direction the contact-consent
// rule forbids. The one send in this family (#2161's bedtime wear reminder) lives
// behind an explicit Settings → Notifications opt-in and may be offered nowhere else.

test("Data → Review names a device that stopped sending while its provider syncs green (#2146)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_QUIET_STREAM,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/data?section=review");

    const card = page.getByTestId("quiet-streams");
    await expect(card).toBeVisible();
    await expect(card).toContainText("A device stopped sending");

    const row = page.getByTestId("quiet-stream-health-connect");
    await expect(row).toBeVisible();
    // It states the surprise — the connection is FINE — then the observation, then
    // asks. It never claims a failure and never issues an instruction.
    await expect(row).toContainText(
      "is syncing, but heart-rate data has stopped"
    );
    await expect(row).toContainText("No heart-rate data has arrived since");
    await expect(row).toContainText("hours ago");
    await expect(row).toContainText("Is the watch on your wrist and charged?");
    await expect(row).not.toContainText("sync failed");
    await expect(row).not.toContainText("Reconnect");

    // A healthy connection, so the escalation card must NOT have claimed it: #2146
    // constraint 7 gives one row per provider and the escalating kinds win.
    await expect(page.getByTestId("import-issue-health-connect")).toHaveCount(
      0
    );
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});

test("the quiet-stream row offers NO push-shaped affordance anywhere (#2146 constraint 4)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_QUIET_STREAM,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/data?section=review");
    const card = page.getByTestId("quiet-streams");
    await expect(card).toBeVisible();

    // Nothing inside the card may offer to contact the user about this.
    for (const name of [/remind/i, /notify/i, /alert/i, /subscribe/i]) {
      await expect(card.getByRole("button", { name })).toHaveCount(0);
      await expect(card.getByRole("link", { name })).toHaveCount(0);
    }
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    await expect(card.getByRole("switch")).toHaveCount(0);
    // The card's ONLY affordance is a read-only link to the provider's own page.
    const links = card.getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute("href", "/integrations/health-connect");

    // And it did not travel: the dashboard's non-hideable Needs-attention hero and
    // the Upcoming page are escalation surfaces, and a coaching-tier observation may
    // not appear on either.
    await page.goto("/upcoming");
    await expect(page.getByText("heart-rate data has arrived")).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByText("heart-rate data has arrived")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
