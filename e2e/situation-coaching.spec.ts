import { test, expect } from "./fixtures";
import { appContent } from "./helpers";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_SITCOACH } from "./fixture-logins";

// Situation-aware coaching (#837) + situation-activation visibility (#662 item 1).
// The SITCOACH fixture (seed-events.ts) is a sick profile (open flagged-illness
// episode) WITH training history and one situational supplement tied to the active
// Illness situation. Read-only assertions, so the fixture stays repeat-safe under
// CI's --repeat-each=3 and never perturbs the other sick fixtures.

function creds(username: string) {
  return { username, password: E2E_MEMBER_PASSWORD };
}

test("Home's next-workout seat holds nags during an open illness episode (#837)", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SITCOACH));

  // Home's Next workout seat carries the top recommendation as its detail line
  // (#5435 §3.2), so the calm HELD note — routine training nudges are paused while
  // the episode is open — is what the seat states, instead of a "go train" gap nag.
  // The Show-everything fold this used to read went with the ranker; the claim did
  // not, because the statement moved to the seat rather than disappearing.
  await page.goto("/");
  await expect(appContent(page).getByTestId("home-training")).toContainText(
    "Recovery mode — coaching paused"
  );

  // The training overview's next-workout card renders the SAME top recommendation
  // (one computation, #221), so it shows the held note too — never a go-train title.
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("next-workout-title")).toHaveText(
    "Recovery mode — coaching paused"
  );

  await page.context().close();
});

test("supplement schedule acknowledges active situational items without owning the controls (#662 item 1)", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SITCOACH));

  await page.goto("/nutrition?tab=supplements");

  await expect(page.getByTestId("situations-bar")).toHaveCount(0);
  // The one-line acknowledgment still explains why the seeded Zinc dose is due.
  await expect(page.getByTestId("situation-activation")).toHaveText(
    "1 situational item now active"
  );

  await page.context().close();
});
