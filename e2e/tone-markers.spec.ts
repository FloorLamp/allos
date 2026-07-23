import { test, expect } from "@playwright/test";

// WCAG 1.4.1 (issue #1220): the healthspan pillars and the recent-lab flags must
// never convey their good/warn/bad judgment by COLOR ALONE. Every judging pillar
// tone pairs its value color with a text badge (PILLAR_TONE_LABEL — one mapping
// shared by the dashboard widget and the Longevity page), and every directional
// lab-flag caret carries a text equivalent (sr-only flagLabel) plus a visible
// status label on the Recent labs widget.
//
// Read-only over the seeded pages (suite hygiene #868): seed profile 1 owns
// judged labs with directional flags, so the optimal-biomarkers pillar and
// flagged lab rows are guaranteed present without exact-count assertions.

// The badge wording per tone — mirrors lib/healthspan-pillars' PILLAR_TONE_LABEL
// (pinned exactly by the pure tier; duplicated here because Playwright specs
// don't import app code through the @/ alias).
const TONE_BADGE: Record<string, string> = {
  good: "Good",
  warn: "Fair",
  bad: "Poor",
};

const DIRECTIONAL_LABELS = ["High", "Low", "Above optimal", "Below optimal"];

// Assert every pillar card in `cards` pairs its tone with the badge text (or, for
// neutral, deliberately carries none). The cards are server-rendered, so once the
// container is visible the collection is stable and a plain count loop is safe.
async function expectTonesBadged(
  cards: import("@playwright/test").Locator
): Promise<void> {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const tone = await card.getAttribute("data-tone");
    const badge = card.getByTestId("pillar-tone-badge");
    if (tone === "neutral") {
      // No judgment → no badge (and the value renders in the plain text color).
      await expect(badge).toHaveCount(0);
    } else {
      expect(tone, "every pillar card carries data-tone").toBeTruthy();
      await expect(badge).toHaveText(TONE_BADGE[tone!]);
    }
  }
}

test("dashboard healthspan pillars pair every tone with a text badge (#1220)", async ({
  page,
}) => {
  await page.goto("/");
  const widget = page
    .getByRole("main")
    .getByTestId("healthspan-pillars-widget");
  await expect(widget).toBeVisible();

  // Seed profile 1 owns judged labs, so the optimal-biomarkers pillar renders —
  // and it is never neutral (a zero-denominator pillar hides instead), so a badge
  // is guaranteed without depending on WHICH verdict the seed lands on.
  const optimal = widget.getByTestId("pillar-optimal-biomarkers");
  await expect(optimal).toBeVisible();
  await expect(optimal.getByTestId("pillar-tone-badge")).toHaveText(
    /^(Good|Fair|Poor)$/
  );

  await expectTonesBadged(widget.locator("[data-tone]"));
});

test("the Longevity page's pillar stats carry the same tone badges (#1220)", async ({
  page,
}) => {
  test.slow(); // next dev compiles the route on first hit
  await page.goto("/longevity");
  const main = page.getByRole("main");

  const optimal = main.getByTestId("longevity-pillar-optimal-biomarkers");
  await expect(optimal).toBeVisible();
  await expect(optimal.getByTestId("pillar-tone-badge")).toHaveText(
    /^(Good|Fair|Poor)$/
  );

  await expectTonesBadged(
    main.locator('[data-testid^="longevity-pillar-"][data-tone]')
  );
});

test("recent-lab carets carry a text equivalent and a visible severity label (#1220)", async ({
  page,
}) => {
  await page.goto("/");
  const recentLabs = page
    .getByRole("main")
    .getByTestId("dashboard-widget-recent-labs");
  await expect(recentLabs).toBeVisible();

  // The seeded profile has directional (high/low) flags among its recent labs.
  // Each caret is decorative (aria-hidden) and pairs with an sr-only flagLabel —
  // the severity ("High" vs "Above optimal") is text, not just red-vs-amber.
  const srText = recentLabs.getByTestId("medical-flag-text");
  await expect(srText).not.toHaveCount(0);
  for (const t of await srText.allTextContents()) {
    expect(DIRECTIONAL_LABELS).toContain(t.trim());
  }

  // And the widget row shows a VISIBLE status label for directional flags too
  // (the color-blind-visible channel; directionless statuses already had one).
  const statuses = await recentLabs
    .getByTestId("recent-lab-status")
    .allTextContents();
  expect(
    statuses.filter((s) =>
      DIRECTIONAL_LABELS.some((label) => s.includes(label))
    ).length
  ).toBeGreaterThan(0);
});
