import { expect, test } from "./fixtures";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { loginAs } from "./nav";

test.describe("age-neutral training tools (#3067)", () => {
  test("a minor reaches the full Training hub and activity editor", async ({
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

      await member.getByRole("button", { name: "New activity" }).click();
      await expect(member.getByTestId("activity-form")).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
