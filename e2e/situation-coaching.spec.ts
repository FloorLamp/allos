import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_SITCOACH } from "./fixture-logins";

// Situation-aware coaching (#837) + situation-activation visibility (#662 item 1).
// The SITCOACH fixture (seed-events.ts) is a sick profile (open flagged-illness
// episode) WITH training history and one situational supplement tied to the active
// Illness situation. Read-only assertions, so the fixture stays repeat-safe under
// CI's --repeat-each=3 and never perturbs the other sick fixtures.

function creds(username: string) {
  return { username, password: E2E_MEMBER_PASSWORD };
}

test("dashboard coaching widget HOLDS the nags during an open illness episode (#837)", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SITCOACH));

  // The coaching widget (defaultOn) shows the calm HELD note — routine training nudges
  // are paused while the episode is open — instead of a "go train" gap nag.
  await expect(page.getByText("Recovery mode — coaching paused")).toBeVisible();

  // The training overview's next-workout card renders the SAME top recommendation
  // (one computation, #221), so it shows the held note too — never a go-train title.
  await followLink(
    page,
    page.getByRole("link", { name: "Training" }).first(),
    /\/training/
  );
  await expect(page.getByTestId("next-workout-title")).toHaveText(
    "Recovery mode — coaching paused"
  );

  await page.context().close();
});

test("situations bar acknowledges active situational items (#662 item 1)", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SITCOACH));

  await page.goto("/nutrition?tab=supplements");

  // The situations bar is present with Illness active…
  await expect(page.getByTestId("situations-bar")).toBeVisible();
  // …and the one-line activation acknowledgment names the count of situational items
  // now due because a situation is active (the seeded Zinc supplement under Illness).
  await expect(page.getByTestId("situation-activation")).toHaveText(
    "1 situational item now active"
  );

  await page.context().close();
});
