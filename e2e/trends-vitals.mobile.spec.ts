import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { E2E_LOGIN_VITALS_DAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The day-view door on the Trends landing surface (#4767). The census used to offer a
// "1D" pill (#1466) that swapped its daily charts for a clock-axis copy of the day —
// a second intraday rendering with no events on it, whose doors led to metric pages
// that floor at 7D. It retired: the /history day view's intraday panel is the ONE
// intraday surface, and the door to it took the pill's seat in the range-chip row.
//
// Runs in the `mobile` project (390×844) by its file name alone; on a phone the chip
// row is behind the context bar, so the door's reachability there is the claim.
//
// Fixture (#868 hygiene): the dedicated E2E_LOGIN_VITALS_DAY profile seeded by
// e2e/seed-events.ts carries a full intraday day, so the landing panel has content.
// Reads only.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

test.describe("the day-view door stands where 1D sat (#4767)", () => {
  test("no 1D pill, and the door lands on the day view's panel", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const member = await loginAs(
      browser,
      { username: E2E_LOGIN_VITALS_DAY, password: E2E_MEMBER_PASSWORD },
      PHONE
    );
    try {
      await member.goto("/trends?view=all");
      await expandTrendsContext(member);
      await expect(
        member.getByRole("link", { name: "1D", exact: true })
      ).toHaveCount(0);
      // The retired Today strip (#3387) and the retired clock-axis swap (#4767)
      // both stay gone: the census draws daily charts only.
      await expect(member.getByTestId("vitals-today-strip")).toHaveCount(0);
      await expect(member.getByTestId("body-intraday-view")).toHaveCount(0);

      const link = member.getByTestId("body-timeline-link");
      await expect(link).toBeVisible();
      await expect(link).toHaveText("Today on History");
      const href = (await link.getAttribute("href")) ?? "";
      const day = /day=(\d{4}-\d{2}-\d{2})/.exec(href)?.[1];
      expect(day, `no day in the door's href: ${href}`).toBeTruthy();
      await followLink(member, link, new RegExp(`/history\\?day=${day}`));

      await expect(member.getByTestId("intraday-panel")).toBeVisible();
      await expect(member.getByTestId("intraday-panel")).toHaveAttribute(
        "data-intraday-date",
        day!
      );
    } finally {
      await member.context().close();
    }
  });
});
