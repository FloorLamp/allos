import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
// Form hygiene at desktop width (issue #1450, clusters A and B).
//
// Three things the census found and this pins:
//   A. Controls narrower than their own content — a date field clipping its value
//      ("Friday, July 2‹"), a select clipping its default label ("Auto — fi…").
//   B. Disabled primary buttons rendered as washed-out green with white text
//      (`disabled:opacity-50` fading a saturated fill), which reads as broken
//      rather than "finish the form first" — while the admin Delete buttons
//      hand-rolled a different grey, so one page family carried two treatments.
//
// The assertions are structural, never pixel snapshots: "does the rendered text
// fit the box that holds it" and "does the disabled button use the single
// primitive treatment", both read from computed style at run time.
//
// Fixture hygiene (#868): nothing here writes a record. The Family assertions
// read the create-login form's INITIAL (empty, therefore disabled) state without
// submitting it, and the date assertion fills a form field it never saves.

// Width of `text` when painted in `el`'s own font, measured in-page with canvas.
// This is how you ask "does this label fit?" for a native <select>, which clips
// internally and so reports no scrollWidth overflow to give the game away.
async function textFitsControl(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLSelectElement | null;
    if (!el) throw new Error(`no element for ${sel}`);
    const style = getComputedStyle(el);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const label = el.options[el.selectedIndex]?.text ?? "";
    const textWidth = ctx.measureText(label).width;
    // The content box is the element's client width minus its own padding — for a
    // styled select that padding includes the reserved room for the chevron.
    const available =
      el.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    return textWidth <= available + 1;
  }, selector);
}

test("a disabled primary button uses the one accessible disabled treatment (#1450 B)", async ({
  page,
}) => {
  await page.goto("/settings/family");

  // Create login starts disabled (no username, no password) — the exact state the
  // census screenshotted as washed-out green.
  const createLogin = page.getByRole("button", { name: "Create login" });
  await expect(createLogin).toBeVisible();
  await expect(createLogin).toBeDisabled();

  const style = await createLogin.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      opacity: s.opacity,
      backgroundImage: s.backgroundImage,
      backgroundColor: s.backgroundColor,
      color: s.color,
      cursor: s.cursor,
    };
  });

  // Not the old treatment: the fill is no longer a half-faded brand gradient.
  expect(style.opacity).toBe("1");
  expect(style.backgroundImage).toBe("none");
  // It is a muted SURFACE with readable text, and it says "not clickable".
  expect(style.cursor).toBe("not-allowed");
  expect(style.backgroundColor).not.toBe(style.color);

  // And the text actually meets AA against its own background, which
  // white-on-washed-green did not.
  const ratio = await createLogin.evaluate((el) => {
    const s = getComputedStyle(el);
    const parse = (c: string) =>
      (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = lum(parse(s.color));
    const b = lum(parse(s.backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);

  // ONE treatment, not two: the admin Delete button in the same page family
  // resolves to the same disabled surface rather than its own grey.
  const deleteLogin = page
    .getByRole("button", { name: "Sign out devices" })
    .first(); // first-ok: spec asserts the shared disabled treatment on any one instance of this repeated admin row control
  if (await deleteLogin.isDisabled()) {
    const ghost = await deleteLogin.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    );
    expect(ghost).toBe(style.backgroundColor);
  }
});

test("the notification schedule select renders its default label unclipped (#1450 A)", async ({
  page,
}) => {
  await page.goto("/settings/notifications");

  const select = page.getByTestId("supp-morning-hour");
  await expect(select).toBeVisible();

  // The wake-aware "Auto" option is the long one — it used to read "Auto — fi…"
  // in this 4-up grid. Select it so it becomes the rendered label, then measure.
  await select.selectOption("auto");
  expect(
    await textFitsControl(page, '[data-testid="supp-morning-hour"]'),
    "the Morning supps select clips its own selected label"
  ).toBe(true);

  // Restore the shared admin profile's setting so the preference doesn't bleed
  // into other specs (the date-time-format-prefs restore pattern).
  await select.selectOption("");
});

test("the longevity adherence select renders its default label unclipped (#1450 A)", async ({
  page,
}) => {
  await page.goto("/longevity");
  await page.getByTestId("new-protocol-toggle").click();

  const select = page.getByTestId("protocol-practice-type");
  await expect(select).toBeVisible();
  // "No adherence tracking" is the default option and used to render "No a…"
  // inside the narrow protocols rail.
  expect(
    await textFitsControl(page, '[data-testid="protocol-practice-type"]'),
    "the adherence select clips its own default label"
  ).toBe(true);
});

test("a date field displays its own value without clipping (#1450 A / #1448)", async ({
  page,
}) => {
  await page.goto("/encounters");

  // The appointment Date field is the site the census captured as
  // "Friday, July 2‹" at BOTH widths.
  const dateField = page.locator('input[id^="appt-date-"]').first(); // first-ok: the appointment form renders one date field; scoping by its id prefix, order-agnostic
  await expect(dateField).toBeVisible();

  // A December date is the widest the short form gets. DateField submits the ISO
  // value through a hidden input and re-renders the visible field as the formatted
  // display text, so this cannot use settledFill (whose contract is that the
  // filled string STAYS the DOM value). Retry the fill so a pre-hydration one that
  // React reverts is re-applied, and settle on the formatted result.
  await expect(async () => {
    await dateField.fill("2026-12-24");
    // The year-bearing short form, not the year-less long one it used to render.
    await expect(dateField).toHaveValue("Dec 24, 2026", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 }); // topass-ok: the fill and its formatted re-render are one non-atomic step — a bare expect cannot re-apply a fill React reverted before hydration
  const clipped = await dateField.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1
  );
  expect(clipped, "the date field clips its own value").toBe(false);
});
