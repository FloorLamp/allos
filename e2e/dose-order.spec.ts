import { test, expect } from "./fixtures";
import { expandUpcomingAggregates } from "./helpers";
import { TIME_BUCKETS, timeBucket } from "@/lib/intake-schedule";
// Issue #297: on the Upcoming page's Today band, due doses used to sort
// alphabetically because the adapter dropped time_of_day — morning and bedtime
// doses interleaved A–Z. The seed (e2e/seed-events.ts) ships a MORNING dose named
// "Zeaxanthin Morning (e2e)" and a BEDTIME dose named "Ashwagandha Bedtime (e2e)":
// alphabetical order would put the bedtime "A…" first, but bucket order (Morning
// before Before-sleep) must put the morning "Z…" first. This spec pins that the
// rendered order is the bucket order, not alphabetical, and that each dose states
// its bucket.
//
// SINCE #2579-D THE BUCKET IS THE RUN HEADER, not a status column repeated once per
// dose: the expanded fold draws one slot run per bucket and the doses under it are
// chips. Same claim, read off the header the chips now sit beneath — which is a
// STRONGER reading of the same fact, because a header describes every chip under it
// and a per-row label could only ever have described its own row.
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

  // The bucket is surfaced as the run header the dose sits under, so the ordering is
  // self-explaining. Scope to each RUN so we assert the right bucket per dose.
  const runFor = (name: string) =>
    page.getByTestId("upcoming-slot-run").filter({ hasText: name });
  await expect(runFor("Zeaxanthin Morning (e2e)")).toHaveAttribute(
    "data-slot",
    "Morning"
  );
  await expect(runFor("Ashwagandha Bedtime (e2e)")).toHaveAttribute(
    "data-slot",
    "Before sleep"
  );
  // …and the chip under it carries what the header does not: the dose's amount.
  await expect(
    page
      .locator('[data-testid^="upcoming-item-dose:"]')
      .filter({ hasText: "Zeaxanthin Morning (e2e)" })
  ).toBeVisible();
});

test("the dose fold reads in DOSE-DAY order, one run per slot in bucket order (#297/#2578/#2579-D)", async ({
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

  const runs = fold.getByTestId("upcoming-slot-run");
  const slots = await runs.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-slot") ?? "")
  );
  expect(slots.length).toBeGreaterThan(1);
  const ranks = slots.map((s) => TIME_BUCKETS.indexOf(timeBucket(s)));
  // Every header resolved to a real bucket, and the seed spans more than one of them —
  // otherwise this would pass on a page with nothing to order.
  expect(ranks).not.toContain(-1);
  expect(new Set(ranks).size).toBeGreaterThan(1);
  expect(ranks, `slot runs out of order: ${slots.join(" → ")}`).toEqual(
    [...ranks].sort((a, b) => a - b)
  );
  // A bucket opens EXACTLY ONE run — the reader's half of the same fact. The runs are
  // consecutive boundaries of the band's order, so a header appearing twice means the
  // order stopped clustering by bucket, and the page prints one "Morning" the user has
  // to scroll past another "Morning" to finish.
  expect(
    new Set(slots).size,
    `a bucket opened twice: ${slots.join(" → ")}`
  ).toBe(slots.length);

  // Every dose the fold holds is under exactly one of those runs — the fold does not
  // quietly drop a chip that has no slot.
  const chips = await fold
    .locator('[data-testid^="upcoming-item-dose:"]')
    .count();
  const chipsInRuns = await runs
    .locator('[data-testid^="upcoming-item-dose:"]')
    .count();
  expect(chipsInRuns).toBe(chips);
});
