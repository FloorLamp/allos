import { test, expect } from "./fixtures";
import { hydratedClick, settledBoxes } from "./helpers";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// #152: an estimated 1RM gains a bodyweight-band strength-standard from ONE model
// (lib/strength-standards.json) that now feeds every strength-level surface — the
// Analyze "Benchmarks" card, exercise coaching, and the healthspan pillar.
// The seeded adult (profile 1) is male with a known bodyweight and a rich barbell
// history, so the card renders for a core lift. The gate (hidden when sex/bodyweight
// is unset, or for an uncovered lift) is covered exhaustively by the pure unit tests
// (lib/__tests__/strength-standards.test.ts) and the cross-surface agreement by
// lib/__tests__/strength-level-consistency.test.ts — driving the settings form to
// unset sex here would be brittle, so the e2e asserts the live positive path.

test("Analyze opens the unified strength-standards reference (#152, #3465)", async ({
  page,
}) => {
  // Training → Analyze (strength) renders the Benchmarks ladder, now driven by the
  // same strength-standard model as the detail line and pillar. Pin a COVERED core
  // lift via ?item — the default item is the strongest lift (an accessory like Leg
  // Press) with no barbell standard, so it would show no Benchmarks card.
  await page.goto("/training?tab=analyze&kind=strength&item=Back%20Squat");

  const main = page.getByRole("main");
  await expect(main.getByText("Benchmarks", { exact: true })).toBeVisible();
  const standard = main.getByTestId("strength-standard");
  await expect(standard).toContainText("at your bodyweight");
  // The ladder is bodyweight-adjusted (× BW rungs) and labeled as such.
  await expect(
    main.getByText("for your bodyweight & sex").first() // eslint-disable-line no-restricted-properties -- first-ok: asserts the bodyweight-adjusted label renders — order-agnostic presence
  ).toBeVisible();
  await expect(main.getByText(/× BW/).first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: asserts a × BW rung renders — order-agnostic presence

  const trigger = main.getByRole("button", {
    name: /see strength standards/i,
  });
  const target = await trigger.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const inset = Math.abs(
      Number.parseFloat(getComputedStyle(node, "::after").top)
    );
    return { width: box.width, height: box.height, inset };
  });
  expect(
    Math.min(target.width, target.height) + 2 * target.inset
  ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

  await hydratedClick(page, trigger);
  const dialog = page.getByRole("dialog", { name: "Strength standards" });
  await expect(dialog).toBeVisible();
  const [box] = await settledBoxes([dialog]);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});
