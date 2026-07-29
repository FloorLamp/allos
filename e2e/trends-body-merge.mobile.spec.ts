import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { censusRevealed, expandTrendsContext } from "./trends-chrome";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Trends → the MERGED Body census (issue #1486, a SECTION since #1644). Vitals
// retired into Body,
// whose sections read: Today → the two ranked chart runs → growth/history. (#1486
// declared those runs Vitals-then-Composition; #1659 re-sequenced the base layout
// everyday-first, so with no signal firing they now read Composition-then-Vitals —
// the runs rank by their best member.) Logging
// moved to ONE combined "Log measurements" form, behind a collapsed "+ Log" on
// desktop and reachable ONLY through the #1468 quick-entry overlay on a phone.
//
// Everything asserted here is layout- or viewport-shaped — which section comes
// first, whether a form is on the page at all, which fields a life stage sees — so
// it can only be seen from the browser tier. The spec drives BOTH viewports (the
// trends-body-mobile precedent): `loginAs` opens its own context, which does NOT
// inherit the project's `use` block, so each viewport is set explicitly.
//
// Fixtures (#868 hygiene): the shared admin seed for the ADULT questions (reads +
// pure client toggles only — no writes, no exact count of a shared-seed row), and
// the existing dedicated child member (E2E_LOGIN_CHILD → "Riley (child)") for the
// life-stage questions. Riley is read-only here too: the spec only asserts which
// fields the form renders, never submits it.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function openBody(page: Page, query = ""): Promise<void> {
  await page.goto(`/trends${query ? `?${query.replace(/^&/, "")}` : ""}#body`);
  // Below `sm` the chip strip lives inside the collapsed #1485 F context bar, so
  // reaching the section's chip means opening the bar first (a no-op at desktop
  // width).
  await expandTrendsContext(page);
  await censusRevealed(page, "body", "trends-body");
}

test.describe("one census, one ordered stack (#1486)", () => {
  test("the section strip carries no Vitals destination", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openBody(page);
    const tabs = page.getByRole("tab");
    // Four since #1644 folded Body into Overview; the ORDER + phone fit are that
    // issue's spec — trends-compare-fold.mobile.spec.ts. What #1486 owns here is
    // the absence of a Vitals destination of its own.
    await expect(tabs).toHaveCount(4);
    await expect(
      page.getByRole("tab", { name: "Vitals", exact: true })
    ).toHaveCount(0);
  });

  test("a retired ?tab=vitals bookmark still shows the Body census", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    // The param names nothing since #1644 (no shim, #1635) — but the census it
    // used to select is simply on the page it lands on.
    await page.goto("/trends?tab=vitals");
    await expandTrendsContext(page);
    await expect(page.getByTestId("trends-body")).toBeVisible();
    // No redirect layer: the URL is left exactly as the caller wrote it.
    expect(page.url()).toContain("tab=vitals");
  });

  test("the sections render in one stack, Composition before Vitals", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    // view=all pins the classic chart stack, where the two titled sections live.
    await openBody(page, "&view=all&from=2000-01-01&to=2100-01-01");

    const vitals = page.getByTestId("body-section-vitals");
    const composition = page.getByTestId("body-section-body-composition");
    await expect(vitals).toBeVisible();
    await expect(composition).toBeVisible();

    // ONE stack in a decided order — the merge's actual claim. #1486 landed it
    // vitals-first, from the page narrative; #1659 re-sequenced the base layout
    // everyday-first because that order was also the TIE-BREAK, and on a tie it put
    // the clinical block above the metrics a wearable profile checks daily. The runs
    // rank by their best member, so Composition now leads when no signal fires. The
    // Today strip still opens with the vitals — that narrative kept its job.
    const compositionFirst = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="body-section-vitals"]');
      const c = document.querySelector(
        '[data-testid="body-section-body-composition"]'
      );
      if (!v || !c) return null;
      // Node.DOCUMENT_POSITION_FOLLOWING === 4
      return (c.compareDocumentPosition(v) & 4) !== 0;
    });
    expect(compositionFirst).toBe(true);

    // The Today strip precedes both (it is section 1).
    const strip = page.getByTestId("vitals-today-strip");
    if (await strip.isVisible()) {
      const stripFirst = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="vitals-today-strip"]');
        const v = document.querySelector('[data-testid="body-section-vitals"]');
        if (!s || !v) return null;
        return (s.compareDocumentPosition(v) & 4) !== 0;
      });
      expect(stripFirst).toBe(true);
    }
  });

  test("resting HR renders exactly once, in Vitals, with its goal overlay", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openBody(page, "&view=all&from=2000-01-01&to=2100-01-01");

    // ONE card — Body's old copy retired when the metric moved to Vitals.
    const restingHr = page.getByTestId("vitals-resting-hr");
    await expect(restingHr).toHaveCount(1);
    await expect(restingHr).toBeVisible();
    // It sits INSIDE the vitals section, not the composition one.
    await expect(
      page.getByTestId("body-section-vitals").getByTestId("vitals-resting-hr")
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("body-section-body-composition")
        .getByTestId("vitals-resting-hr")
    ).toHaveCount(0);

    // The goal overlay came WITH it — Body's copy owned it, Vitals' did not, and
    // the merge unions the two. The seed carries a "Resting HR under 52" goal, so
    // the card draws its target line AND the projection caption that only a goal
    // overlay produces.
    await expect(restingHr).toContainText("52 bpm");
  });
});

test.describe("logging: desktop uses a modal, mobile uses the overlay (#1486)", () => {
  test("desktop '+ Log' opens the combined form in a modal", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openBody(page);

    const toggle = page.getByTestId("log-measurements-toggle");
    await expect(toggle).toBeVisible();
    // Collapsed by default — the tab is a READING surface.
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);

    await hydratedClick(page, toggle);
    const dialog = page.getByRole("dialog", { name: "Log measurements" });
    await expect(dialog).toBeVisible();
    const form = dialog.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Log measurements" })
    ).toBeVisible();
    await expect(form).not.toHaveClass(/card/);

    // The adult field set, in the issue's static order.
    await expect(form.getByLabel("Weight (kg)")).toBeVisible();
    await expect(form.getByLabel("Body Fat (%)")).toBeVisible();
    await expect(
      form.getByLabel("Blood Pressure (Systolic) (mmHg)")
    ).toBeVisible();
    await expect(
      form.getByLabel("Blood Pressure (Diastolic) (mmHg)")
    ).toBeVisible();
    await expect(form.getByLabel("Oxygen Saturation (%)")).toBeVisible();
    await expect(form.getByLabel("Heart Rate Variability (ms)")).toBeVisible();
    // Adults never see the growth fields.
    await expect(form.getByLabel("Height")).toHaveCount(0);
    expect(await form.getAttribute("data-life-stage")).toBe("adult");

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("mobile carries NO on-page form; a focus= deep link opens the overlay", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await openBody(page);

    // Nothing to scroll past: the phone's logging path is the global quick-log
    // sheet, so the panel renders nothing at all here.
    await expect(page.getByTestId("log-measurements-toggle")).toBeHidden();
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);

    // The #1083 preventive blood-pressure deep link still lands the user in a
    // focused field — via the #1468 overlay rather than an inline form.
    await page.goto("/trends?focus=blood-pressure");
    const sheet = page.getByTestId("quick-entry-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("measurements-quick-add")).toBeVisible();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
  });

  test("the combined form omits the functional-fitness markers; the Fitness check keeps them", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await openBody(page);
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // CADENCE RULE: assessment-cadence measures live with the assessment flow.
    await expect(form.getByLabel("Grip strength (kg)")).toHaveCount(0);
    await expect(form.getByLabel("Chair stands (30s reps)")).toHaveCount(0);
    await expect(form.getByLabel("Single-leg balance (s)")).toHaveCount(0);

    // …and they are all still enterable on /training's guided Fitness check, which
    // writes the very same canonical medical_records rows (pinned end-to-end by
    // lib/__action_tests__/measurements.actions.test.ts).
    await page.goto("/training?tab=fitness");
    await expect(page.getByTestId("fitness-tile-grip")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-chairstand")).toBeVisible();
    await expect(page.getByTestId("fitness-tile-balance")).toBeVisible();
  });
});

test.describe("the form is life-stage gated (#1486)", () => {
  test("a minor's form carries the growth fields on both mounts; an adult's does not", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit
    const child = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // ── Desktop expander ────────────────────────────────────────────────
      await child.setViewportSize(DESKTOP);
      await openBody(child);
      await hydratedClick(child, child.getByTestId("log-measurements-toggle"));
      const form = child.getByTestId("measurements-quick-add");
      await expect(form).toBeVisible();
      expect(await form.getAttribute("data-life-stage")).toBe("minor");
      await expect(form.getByLabel("Height", { exact: true })).toBeVisible();
      // Body fat + HRV are gated OFF for a growth-tracked profile (#493).
      await expect(form.getByLabel("Body Fat (%)")).toHaveCount(0);
      await expect(form.getByLabel("Heart Rate Variability (ms)")).toHaveCount(
        0
      );

      // ── The same ONE component in the #1468 overlay ─────────────────────
      await child.setViewportSize(PHONE);
      await child.goto("/trends?focus=height");
      const sheetForm = child
        .getByTestId("quick-entry-sheet")
        .getByTestId("measurements-quick-add");
      await expect(sheetForm).toBeVisible();
      expect(await sheetForm.getAttribute("data-life-stage")).toBe("minor");
      await expect(
        sheetForm.getByLabel("Height", { exact: true })
      ).toBeVisible();
      await expect(sheetForm.getByLabel("Body Fat (%)")).toHaveCount(0);
    } finally {
      await child.context().close();
    }
  });
});
