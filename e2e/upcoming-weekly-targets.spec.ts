import { test, expect } from "./fixtures";

// #2578 defect 2: what an unmet weekly FLOOR target IS on the Upcoming page, read-only
// against the shared seeded admin profile (scripts/seed.ts), which ships a
// `mobility_region` weekly target its own comment calls partial. Nothing here writes,
// and nothing exact-counts a shared row.

test("a mobility weekly target says mobility, not training (#2578)", async ({
  page,
}) => {
  // `frequency_targets` is scope-generic machinery, and reading a row's presence in
  // it as "a training target" put "Berries — Weekly training target" on the live page
  // under a barbell with a /training link. The seeded mobility_region target is the
  // same defect one scope over.
  await page.goto("/upcoming");
  const row = page
    .locator('[data-testid^="upcoming-item-training:"]')
    .filter({ hasText: "Mobility: Legs" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Weekly mobility target");
  await expect(row).not.toContainText("Weekly training target");
  // Mobility genuinely lives on the Training hub, so the destination was never the
  // wrong half here — only the claim about what the row is.
  await expect(
    row.getByRole("link", { name: "Mobility: Legs" })
  ).toHaveAttribute("href", "/training");
});
