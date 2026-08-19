import { test, expect } from "./fixtures";
// WCAG 1.4.1 (issue #1220): the healthspan pillars and the recent-lab flags must
// never convey their good/warn/bad judgment by COLOR ALONE. Every judging pillar
// tone pairs its value color with a text badge (PILLAR_TONE_LABEL — one mapping
// shared by the dashboard presentation and the Longevity page), and every directional
// lab-flag caret carries the severity WORD as visible text on the Recent labs
// widget (#2315 made that one label the component's own, replacing the sr-only
// span rather than joining it).
//
// Read-only over the seeded pages (suite hygiene #868): seed profile 1 owns
// judged labs with directional flags, so the optimal-biomarkers pillar and
// flagged lab rows are guaranteed present without exact-count assertions.

// The badge wording per tone — mirrors lib/longevity-pillars' PILLAR_TONE_LABEL
// (pinned exactly by the pure tier; duplicated here because Playwright specs
// don't import app code through the @/ alias).
const TONE_BADGE: Record<string, string> = {
  good: "Good",
  warn: "Fair",
  bad: "Poor",
};

const DIRECTIONAL_LABELS = ["High", "Low", "Above optimal", "Below optimal"];

// Every word the widget can draw: the directional ones plus the directionless
// statuses that never had a caret to hang an sr-only label on.
const STATUS_LABELS = [
  ...DIRECTIONAL_LABELS,
  "Abnormal",
  "Immune",
  "Non-optimal",
];

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
