import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { appContent, hydratedClick } from "./helpers";
import { openProtocolFact } from "./protocol-form-helpers";
import { openVisitFact } from "./visit-form-helpers";
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
// B's bearer MOVED with #4978 slice 2, and the reason it moved has since been
// overruled. The census's example was Family's "Create login". Slice 2 demoted
// it on the reading that a settings GROUP route spends its one primary on none
// of its cards; PM ruling 6 (2026-09-09 23:35 UTC) settled that the surface is
// the CARD, so "Create login" is filled again. The subject STAYS on
// /settings/tokens' mint commit anyway, and not because the Family mount is
// unfilled: this test wants a primary that is disabled AT REST, which the mint
// commit is (a required field left empty) on first paint. "Create login" is
// disabled at rest for the same reason, so either would serve; leaving the
// subject here keeps the two halves of this test on two DIFFERENT routes, which
// is what makes the second half a check that the disabled treatment is shared
// app-wide rather than agreed within one page.
//
// The assertions are structural, never pixel snapshots: "does the rendered text
// fit the box that holds it" and "does the disabled button use the single
// primitive treatment", both read from computed style at run time.
//
// Fixture hygiene (#868): nothing here writes a record. The token assertions
// read the mint form's INITIAL (empty, therefore disabled) state without
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
  await page.goto("/settings/tokens");

  // The mint commit starts disabled (no token name) — the exact state the census
  // screenshotted as washed-out green, on the surface that now carries the fill.
  const createToken = appContent(page).getByTestId("api-token-create");
  await expect(createToken).toBeVisible();
  await expect(createToken).toBeDisabled();

  const style = await createToken.evaluate((el) => {
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
  const ratio = await createToken.evaluate((el) => {
    const s = getComputedStyle(el);
    // Tailwind 4 authors palette colors in CSS Color 4 (lab/oklch), so let the
    // browser rasterize either legacy rgb() or modern color syntax to sRGB
    // before applying the WCAG luminance formula.
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
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

  // ONE treatment, not two: the admin row control over on Family resolves to the
  // same disabled surface rather than its own grey.
  //
  // WHAT THIS HALF PROVES CHANGED WITH #4978 SLICE 4, so the comment changes with
  // it. It used to be a CROSS-FAMILY check — the Family control was still a raw
  // `btn-ghost`, so the two families had to agree on the disabled surface for as
  // long as both were mounted. Slice 4 converted that row, and both controls are
  // now the primitive. What is left is the check that survives the convergence and
  // is worth more once the raw family is gone: the rank paints are scoped away from
  // the disabled treatment (`button-control-primary` / `-danger` are
  // `:not(:disabled)`), so a DISABLED primary must resolve to exactly the muted
  // surface a plain secondary does. Unscope either utility and this reddens with a
  // saturated fill on the left of the comparison — which is #1450 B's own defect,
  // restated on the primitive that inherited it.
  await page.goto("/settings/family");
  // eslint-disable-next-line no-restricted-properties -- first-ok: spec asserts the shared disabled treatment on any one instance of this repeated admin row control
  const signOutDevices = page
    .getByRole("button", { name: "Sign out devices" })
    .first();
  await expect(signOutDevices).toBeVisible();
  if (await signOutDevices.isDisabled()) {
    const ghost = await signOutDevices.evaluate(
      (el) => getComputedStyle(el).backgroundColor
    );
    expect(ghost).toBe(style.backgroundColor);
  }
});

test("the notification schedule select renders its default label unclipped (#1450 A)", async ({
  page,
}) => {
  await page.goto("/settings/notifications");

  const select = page.getByTestId("intake-morning-hour");
  await expect(select).toBeVisible();

  // The wake-aware "Auto" option is the long one — it used to read "Auto — fi…"
  // in this 4-up grid. Select it so it becomes the rendered label, then measure.
  await select.selectOption("auto");
  expect(
    await textFitsControl(page, '[data-testid="intake-morning-hour"]'),
    "the Morning intake select clips its own selected label"
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

  // The select is behind the practice chip since #3219, so the clipping question is
  // asked of it OPEN — which is the only state in which it has a width at all.
  const form = page.getByTestId("protocol-form");
  await expect(form).toBeVisible();
  await openProtocolFact(form, "practice");

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
  await page.goto("/records/history/visits");
  await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));

  // The appointment Date field is the site the census captured as
  // "Friday, July 2‹" at BOTH widths.
  //
  // IT IS BEHIND A FACT CHIP SINCE #3223, so the panel is opened before the field is
  // measured. Nothing else about this test changes: a control that clips its own value
  // clips it just as badly inside a disclosure.
  const addVisit = page.getByRole("dialog", { name: "Add visit" });
  await openVisitFact(addVisit, "when");
  const dateField = addVisit.locator('input[id^="appt-date-"]');
  await expect(dateField).toBeVisible();

  // A December date is the widest the short form gets. DateField submits the ISO
  // value through a hidden input and re-renders the visible field as the formatted
  // display text, so this cannot use settledFill (whose contract is that the
  // filled string STAYS the DOM value). Retry the fill so a pre-hydration one that
  // React reverts is re-applied, and settle on the formatted result.
  // eslint-disable-next-line no-restricted-properties -- topass-ok: the fill and its formatted re-render are one non-atomic step — a bare expect cannot re-apply a fill React reverted before hydration
  await expect(async () => {
    await dateField.fill("2026-12-24");
    // The year-bearing short form, not the year-less long one it used to render.
    await expect(dateField).toHaveValue("Dec 24, 2026", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const clipped = await dateField.evaluate(
    (el) => el.scrollWidth > el.clientWidth + 1
  );
  expect(clipped, "the date field clips its own value").toBe(false);
});
