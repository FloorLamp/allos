import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent, settledBoxes } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_NOWSTRIP,
  E2E_LOGIN_NOWSAFETY,
} from "./fixture-logins";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 }, hasTouch: false };

async function openDashboard(
  browser: Browser,
  creds: { username: string },
  contextOptions: Record<string, unknown> = PHONE
): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: creds.username, password: E2E_MEMBER_PASSWORD },
    contextOptions
  );
  await page.goto("/");
  return page;
}

test("phone leads with the bounded Now lane", async ({ browser }) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSTRIP,
  });
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toHaveCount(0);
    const strip = page.getByTestId("now-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-count", "2");
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});

test("Now stays one column at every viewport", async ({ browser }) => {
  for (const options of [PHONE, DESKTOP]) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_NOWSTRIP },
      options
    );
    try {
      const strip = page.getByTestId("now-strip");
      const cards = strip.locator("[data-testid^='now-strip-card-']");
      await expect(cards).toHaveCount(2);
      const [top, bottom] = await settledBoxes([cards.nth(0), cards.nth(1)]);
      expect(bottom.y).toBeGreaterThan(top.y + top.height / 2);
      expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
      expect(Math.abs(bottom.width - top.width)).toBeLessThan(2);
    } finally {
      await page.context().close();
    }
  }
});

test("desktop keeps the page header", async ({ browser }) => {
  const page = await openDashboard(
    browser,
    { username: E2E_LOGIN_NOWSTRIP },
    DESKTOP
  );
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("safety facts are uncapped and cannot be collapsed", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSAFETY,
  });
  try {
    const safety = page.locator(
      "[data-testid^='now-strip-card-attention.fact:mental-health:crisis']"
    );
    await expect(safety).toHaveCount(1);
    const fact = safety.getByTestId("needs-attention");
    await expect(fact).toHaveAttribute("data-locked", "true");
    await expect(fact).toHaveAttribute("data-collapsed", "false");
    await expect(
      fact.getByRole("button", { name: /Collapse|Expand/ })
    ).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
