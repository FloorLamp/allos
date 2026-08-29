import { test, expect } from "./fixtures";
import type { Browser } from "@playwright/test";
import {
  CONTROL_BOX_PX,
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
  TAP_TARGET_INSET_PX,
} from "@/lib/tap-floor-tokens";

// THE SIGN-IN CONTROLS, AT THEIR REAL MOUNT (#3752). /login sits OUTSIDE the app
// shell, and its submit and fields used to be hand-styled copies of the shared
// owners — a `useFormStatus` button with its own padding and three inputs with
// their own border, fill and focus colour. Adopting `SubmitButton` and `.input`
// is only worth anything if the box those owners promise actually reaches this
// route, so this measures it here rather than trusting that the class arrived.
//
// It measures RENDERED geometry, and it measures the two controls AGAINST EACH
// OTHER as well as against the constant: "34px" alone also passes on a page where
// everything shrank together, and the ruling's claim (#3938) is that the kinds
// AGREE. The route needs an anonymous context — the page redirects a live
// session straight back out — so the phone viewport and the coarse pointer are
// stated here instead of inherited from the project.
const PHONE = { width: 390, height: 844 };

async function anonymousPhone(browser: Browser) {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: PHONE,
    hasTouch: true,
  });
  return ctx.newPage();
}

type Measured = {
  height: number;
  width: number;
  reach: number;
  fontSize: number;
};

test("the sign-in submit and fields wear the app's control box", async ({
  browser,
}) => {
  const page = await anonymousPhone(browser);
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  const measured: Measured[] = await page.evaluate(
    (selectors: string[]) =>
      selectors.map((selector) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) throw new Error(`${selector} is not in the DOM`);
        const after = getComputedStyle(el, "::after");
        const style = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          width: el.getBoundingClientRect().width,
          reach:
            after.content === "none"
              ? 0
              : Math.abs(Number.parseFloat(after.top)),
          fontSize: Number.parseFloat(style.fontSize),
        };
      }),
    [
      'button[type="submit"]',
      'input[name="username"]',
      'input[name="password"]',
    ]
  );

  const [submit, username, password] = measured;

  // Every control on the route renders the one box …
  for (const control of [submit, username, password]) {
    expect(control.height).toBeCloseTo(CONTROL_BOX_PX, 1);
  }
  // … and renders the SAME box as the others, which is the part a shared owner buys.
  expect(username.height).toBe(submit.height);
  expect(password.height).toBe(username.height);

  // The submit spans the card the way the deleted `w-full` did — the form is a
  // flex COLUMN, so a stretched item is the arrangement's doing and not a class
  // the primitive would have had to grow a variant for.
  expect(submit.width).toBe(username.width);

  // The submit repairs its reach on a coarse pointer; a typed field cannot grow a
  // pseudo-element, so its box IS its target — the #3938 split, not an exception.
  expect(submit.reach).toBeCloseTo(TAP_TARGET_INSET_PX, 1);
  expect(submit.height + 2 * submit.reach).toBeGreaterThanOrEqual(
    TAP_FLOOR_PX - TAP_FLOOR_FLOAT_EPSILON_PX
  );
  expect(username.reach).toBe(0);

  // `.input` is `text-base` for one reason: iOS Safari zooms the page when a
  // focused control is under 16px, which no amount of viewport meta undoes.
  expect(username.fontSize).toBeGreaterThanOrEqual(16);
  expect(password.fontSize).toBe(username.fontSize);

  await page.context().close();
});

test("the sign-in field keeps its autofocus and its focus boundary", async ({
  browser,
}) => {
  const page = await anonymousPhone(browser);
  await page.goto("/login");

  // `autoFocus` survived the move to `.input`: the field is focused once React
  // has hydrated, so a returning user types straight into it.
  await expect
    .poll(async () =>
      page.evaluate(
        () => (document.activeElement as HTMLInputElement | null)?.name ?? null
      )
    )
    .toBe("username");

  // The focus boundary is asserted as a RELATIONSHIP between the same field's two
  // states, not against a colour literal: `.input`'s `focus:border-brand-500` is
  // what tells a person which control is taking their keystrokes, and a class that
  // arrived without its focus rule would still be 34px tall and still look fine.
  const boundary = await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      'input[name="password"]'
    );
    if (!el) throw new Error("password field is not in the DOM");
    const resting = getComputedStyle(el).borderTopColor;
    el.focus();
    return { resting, focused: getComputedStyle(el).borderTopColor };
  });
  expect(boundary.focused).not.toBe(boundary.resting);

  await page.context().close();
});
