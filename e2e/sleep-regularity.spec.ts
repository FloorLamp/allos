import { test, expect } from "@playwright/test";

// Issue #160: the Trends → Body section surfaces a Sleep Regularity Index (SRI)
// card once enough nights of sleep sessions exist. e2e/seed-events.ts seeds 28
// nightly sleep sessions for profile 1 (the default authed profile), so the
// rolling 28-night window clears the minimum-nights gate and the card renders.
//
// Isolation: everything is scoped to getByRole("main") and reads only the seeded
// SRI fixture; it mutates no rows, so it can't disturb other specs.

test("Trends → Body renders the Sleep Regularity Index card (#160)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");
  await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  const main = page.getByRole("main");
  const card = main.getByTestId("sleep-regularity");
  await expect(card).toBeVisible();

  // The SRI headline value is an integer in −100..100. The seeded schedule is
  // highly regular, so it renders a high positive number.
  const value = card.getByTestId("sri-value");
  await expect(value).toBeVisible();
  const sri = Number((await value.innerText()).trim());
  expect(Number.isFinite(sri)).toBe(true);
  expect(sri).toBeGreaterThan(0);
  expect(sri).toBeLessThanOrEqual(100);

  // The companion caption (bedtime/wake spread + weekend shift) is present.
  await expect(card.getByText(/Bedtime ±/)).toBeVisible();
});
