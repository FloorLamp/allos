import { expect, test } from "./fixtures";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { loginAs } from "./nav";

test.describe("age-appropriate training tools (#3067)", () => {
  test("a child keeps activity history/logging without strength programming", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/training?tab=log");
      await expect(member).toHaveURL(/\/training/);
      await expect(member.getByRole("tab", { name: "Overview" })).toBeVisible();
      await expect(member.getByRole("tab", { name: "Analyze" })).toBeVisible();
      await expect(member.getByRole("tab", { name: "Plan" })).toBeVisible();
      await expect(member.getByTestId("start-workout")).toHaveCount(0);

      await member.getByRole("button", { name: "New activity" }).click();
      await expect(member.getByTestId("activity-form")).toBeVisible();
      const activity = member
        .getByTestId("activity-part")
        .getByRole("combobox", { name: "Activity" });
      await activity.fill("Back Squat");
      await expect(
        member.getByTestId("combobox-option").filter({ hasText: "Back Squat" })
      ).toHaveCount(0);

      await member.getByRole("button", { name: "Close" }).click();
      await member.getByRole("tab", { name: "Plan" }).click();
      await expect(member.getByText("Build a routine")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
