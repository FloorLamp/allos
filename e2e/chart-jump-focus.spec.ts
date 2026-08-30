import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_TRENDS_BODY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

declare global {
  interface Window {
    __rafGate: { hold(): void; pending(): number; release(): Promise<void> };
  }
}

async function installFrameGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    let held = false;
    let id = -1;
    window.requestAnimationFrame = (callback) => {
      if (!held) return request(callback);
      pending.set(id, callback);
      return id--;
    };
    window.cancelAnimationFrame = (frame) => {
      if (!pending.delete(frame)) cancel(frame);
    };
    window.__rafGate = {
      hold: () => {
        held = true;
      },
      pending: () => pending.size,
      release: () => {
        held = false;
        const callbacks = [...pending.values()];
        pending.clear();
        return new Promise((resolve) =>
          request((time) => {
            for (const callback of callbacks) callback(time);
            request(() => resolve());
          })
        );
      },
    };
  });
}

test("chart-menu open focus cannot overwrite a landed keystroke (#4037)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_TRENDS_BODY,
    password: E2E_MEMBER_PASSWORD,
  });
  await installFrameGate(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/trends?view=all");

  const trigger = page.getByTestId("chart-jump-menu-trigger");
  const options = page.getByTestId("chart-jump-menu-options");
  const items = options.locator('[role="menuitemradio"]');
  const hostLanding = page.getByTestId("chart-jump-weight");
  await trigger.focus();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.evaluate(() => window.__rafGate.hold());
  await page.keyboard.press("ArrowDown");
  await expect(hostLanding).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.evaluate(() => window.__rafGate.release());
  await expect(items.nth(1)).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(0);

  await page.goto("/trends?view=all#sleep");
  await expect(page.locator("#sleep")).toBeInViewport();
  const deepLinkY = await page.evaluate(() => scrollY);
  expect(deepLinkY).toBeGreaterThan(0);
  await trigger.evaluate((element) => element.focus({ preventScroll: true }));
  expect(await page.evaluate(() => scrollY)).toBe(deepLinkY);
  await page.evaluate(() => window.__rafGate.hold());
  await page.keyboard.press("ArrowDown");
  const selectedIndex = await items.evaluateAll((nodes) =>
    nodes.findIndex((node) => node.getAttribute("aria-checked") === "true")
  );
  expect(selectedIndex).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => window.__rafGate.pending()))
    .toBeGreaterThan(0);
  await page.evaluate(() => window.__rafGate.release());
  await expect(items.nth(selectedIndex)).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(deepLinkY);
  await page.context().close();
});
