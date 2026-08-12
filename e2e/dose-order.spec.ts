import { test, expect } from "./fixtures";
import { expandUpcomingAggregates } from "./helpers";
import { TIME_BUCKETS, timeBucket } from "@/lib/intake-schedule";
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
  // The band's scheduled doses fold into one disclosure (#1504). The rows and their
  // order are unchanged — they are simply behind it, so open it before comparing.
  await expandUpcomingAggregates(page.getByRole("main"), "dose");

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

test("the dose fold reads in DOSE-DAY order, matching the slot label on each row (#297/#2578)", async ({
  page,
}) => {
  // Since #1096 the page renders every view through mergeAttentionPageGroups, whose
  // comparator had lost the #297 sortHint — so the fold came back ordered by raw key
  // string ("dose:104" before "dose:12") while each row carried the slot label that
  // was added to EXPLAIN the ordering. The label and the order have to agree.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/upcoming");
  await expect(page.getByTestId("upcoming-total")).toBeVisible();
  await expandUpcomingAggregates(page, "dose");

  const fold = page.getByTestId("upcoming-aggregate-dose");
  await expect(fold).toHaveJSProperty("open", true);

  // The row's status IS its bucket, optionally qualified by a cadence
  // ("Morning · Mondays"), so the bucket is the head of that line.
  const statuses = await fold.getByTestId("upcoming-status").allInnerTexts();
  expect(statuses.length).toBeGreaterThan(1);
  const ranks = statuses.map((s) =>
    TIME_BUCKETS.indexOf(timeBucket(s.split("·")[0].trim()))
  );
  // Every label resolved to a real bucket, and the seed spans more than one of them —
  // otherwise this would pass on a page with nothing to order.
  expect(ranks).not.toContain(-1);
  expect(new Set(ranks).size).toBeGreaterThan(1);
  expect(ranks, `slot labels out of order: ${statuses.join(" → ")}`).toEqual(
    [...ranks].sort((a, b) => a - b)
  );
});
