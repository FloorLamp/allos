import { test, expect } from "./fixtures";

// A weekly floor target on /upcoming, read-only against the shared seeded admin
// profile (scripts/seed.ts), which ships a `mobility_region` weekly target its own
// comment calls partial. Nothing here writes, and nothing exact-counts a shared row.
//
// #2578 defect 2 gave the row its SCOPE's identity: "Berries — Weekly training target"
// under a barbell with a /training link was one generic reader treating scope-generic
// machinery as training. #2579-E then takes that identity OFF the second line, because
// on this page the pace column, the title and the glyph already carry it — so what
// this spec pins is both halves at once: the row is one line, and what it kept is
// still about mobility rather than training.

test("a weekly target is one line, and still says which scope it is (#2579-E)", async ({
  page,
}) => {
  await page.goto("/upcoming");
  const row = page
    .locator('[data-testid^="upcoming-item-training:"]')
    .filter({ hasText: "Mobility: Legs" });
  await expect(row).toHaveCount(1);

  // The pace IS the row's content — the status column states it, so a second line
  // reading "Weekly mobility target" spends height restating the heading above it.
  await expect(row).toContainText(/\/3 this week/);
  await expect(row).not.toContainText(/Weekly \w+ target/);

  // Identity survives the compaction: the title still names the scope the #2578 defect
  // got wrong, and mobility genuinely lives on the Training hub, so the destination
  // was never the wrong half here.
  await expect(
    row.getByRole("link", { name: "Mobility: Legs" })
  ).toHaveAttribute("href", "/training");
});
