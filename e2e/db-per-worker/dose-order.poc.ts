import { test, expect } from "../db-per-worker.fixture";

// Issue #297: on the Upcoming page's Today band, due doses used to sort
// alphabetically because the adapter dropped time_of_day — morning and bedtime
// doses interleaved A–Z. The seed (e2e/seed-events.ts) ships a MORNING dose named
// "Zeaxanthin Morning (e2e)" and a BEDTIME dose named "Ashwagandha Bedtime (e2e)":
// alphabetical order would put the bedtime "A…" first, but bucket order (Morning
// before Before-sleep) must put the morning "Z…" first. This spec pins that the
// rendered order is the bucket order, not alphabetical, and that each dose row
// shows its bucket label as the due-text.
test("Upcoming Today band orders doses by time bucket, not alphabetically (#297)", async ({
  page,
}) => {
  await page.goto("/upcoming");

  const morning = page.getByText("Zeaxanthin Morning (e2e)");
  const bedtime = page.getByText("Ashwagandha Bedtime (e2e)");
  await expect(morning).toBeVisible();
  await expect(bedtime).toBeVisible();

  // Compare vertical positions: the morning dose must render ABOVE the bedtime
  // dose (bucket order), the reverse of what an alphabetical sort would give.
  const morningBox = await morning.boundingBox();
  const bedtimeBox = await bedtime.boundingBox();
  expect(morningBox).not.toBeNull();
  expect(bedtimeBox).not.toBeNull();
  expect(morningBox!.y).toBeLessThan(bedtimeBox!.y);

  // The bucket label is surfaced as the dose's due-text so the ordering is
  // self-explaining. Scope to each row so we assert the right label per dose.
  const morningRow = page
    .locator('[data-testid^="upcoming-item-dose:"]')
    .filter({ hasText: "Zeaxanthin Morning (e2e)" });
  const bedtimeRow = page
    .locator('[data-testid^="upcoming-item-dose:"]')
    .filter({ hasText: "Ashwagandha Bedtime (e2e)" });
  await expect(morningRow).toContainText("Morning");
  await expect(bedtimeRow).toContainText("Before sleep");
});
