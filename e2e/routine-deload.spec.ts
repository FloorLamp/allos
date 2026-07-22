import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_ROUTINE_DELOAD,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Issue #741 — deload-week copy on the routine "Today's session" card. Driven as the
// dedicated deload fixture login (an ADULT profile with an ACTIVE PPL routine whose
// 2-week mesocycle places today in its deload week — see e2e/seed-events.ts). SEPARATE
// from the #740 recommendation fixture so that spec's non-deload copy stays intact.
//
//   1. The card renders the deload badge (the softened copy).
//   2. The slate is deload-adjusted: one fewer working set per slot (4 → 3).

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINE_DELOAD,
    password: E2E_MEMBER_PASSWORD,
  });
});

test.afterAll(async () => {
  await page.close();
});

test("Today's session card shows deload copy in the deload week (#741)", async () => {
  await page.goto("/training?tab=overview");

  const card = page.getByTestId("todays-session-card");
  await expect(card).toBeVisible();
  // Day 0 of the PPL routine is Push — the day still resolves, just softened.
  await expect(card.getByTestId("todays-session-title")).toHaveText("Push day");
  // The deload badge names the softened week.
  await expect(card.getByTestId("deload-badge")).toBeVisible();
  // The slate is deload-adjusted: one fewer working set (the PPL Push slate is
  // 4 × 5–8 at full volume, so 3 × 5–8 during the deload).
  await expect(card.getByText("3 × 5–8").first()).toBeVisible(); // first-ok: several exercises in this scoped card share the 3×5–8 deload scheme; assert it renders at all
  await expect(card.getByText("4 × 5–8")).toHaveCount(0);
});
