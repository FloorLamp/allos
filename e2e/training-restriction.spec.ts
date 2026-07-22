import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Type-aware training restriction (issue #489). Under the seeded min-training-age
// gate (13), a member whose sole active profile is "Riley (child)" is restricted.
// The restriction now protects the ADULT fitness apparatus (strength e1RM/standards,
// fitness-age, coaching, goals, equipment) but NOT the age-neutral activity domain:
// /training no longer bounces such a profile — it renders a lightweight sport/cardio
// activity log where the child can record a practice and see it listed, with none of
// the adult analytics tabs.
test.describe("Type-aware training restriction (#489)", () => {
  test("a restricted child reaches a lightweight sport/cardio log, not the adult hub", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/training");
      // It does NOT redirect to the dashboard — the restricted profile stays on
      // /training and gets the activity log.
      await expect(member).toHaveURL(/\/training/);
      await expect(
        member.getByRole("heading", { name: "Activity", exact: true })
      ).toBeVisible();

      // The lightweight log form is present; the adult analytics tabs are not.
      const form = member.getByTestId("activity-log-form");
      await expect(form).toBeVisible();
      await expect(member.getByRole("tab", { name: "Analyze" })).toHaveCount(0);
      await expect(member.getByRole("tab", { name: "Goals" })).toHaveCount(0);
      // No adult strength framing — the type picker only offers sport/cardio.
      await expect(form.getByRole("option", { name: /Sport/ })).toHaveCount(1);
      await expect(form.getByRole("option", { name: /Strength/ })).toHaveCount(
        0
      );

      // Log a sport session; it persists and shows in the recent-sessions list.
      const title = `E2E Soccer ${Date.now()}`;
      await form.getByLabel("What did you do?").fill(title);
      await form.getByLabel("Duration (min)").fill("45");
      await form.getByRole("button", { name: "Log session" }).click();
      await expect(member.getByText("Session logged")).toBeVisible();
      await expect(
        member.getByTestId("activity-log-list").getByText(title)
      ).toBeVisible();

      // #618: the sport session is age-neutral, so it must ALSO surface on the
      // Timeline for the restricted profile — not be hidden with the adult
      // strength/goals domain (the surface-parity gap #489 left behind). The
      // session date defaults to today, so it lands at the top of the feed.
      await member.goto("/timeline");
      await expect(member.getByText(title).first()).toBeVisible(); // first-ok: the sport session THIS test created lands at the top of the restricted profile's timeline
    } finally {
      await member.context().close();
    }
  });
});
