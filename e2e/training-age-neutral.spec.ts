import { expect, test } from "./fixtures";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { loginAs } from "./nav";

test.describe("age-appropriate training tools (#3067)", () => {
  test("a toddler is not offered the workout product", async ({ browser }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/training?tab=log");
      await expect(member).toHaveURL(/\/$/);
      await expect(member.getByRole("link", { name: "Training" })).toHaveCount(
        0
      );
      await expect(member.getByTestId("start-workout")).toHaveCount(0);
      await expect(
        member.getByRole("button", { name: /log activity/i })
      ).toHaveCount(0);
      await expect(member.getByText("Build a routine")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
