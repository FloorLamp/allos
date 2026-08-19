import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The Training Log is the activity index. Every row reaches the canonical
// activity page at every viewport; records no longer expand into a second
// desktop pane or a phone-only inline presentation.

test("activity rows open the canonical activity page", async ({ page }) => {
  await page.goto("/training?tab=log");
  const row = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: newest seeded Push day; its strength parts prove the compact index reuses activity detail
  await expect(row).toBeVisible();
  await expect(row.getByTestId("activity-parts")).toBeVisible();
  await expect(row.getByTestId("training-log-strength-row")).not.toHaveCount(0);
  const id = (await row.getAttribute("id"))!.replace("activity-", "");
  const detailLink = row.getByRole("link", { name: "Push day", exact: true });
  await expect(detailLink).toHaveAttribute("href", `/training/activity/${id}`);

  await followLink(page, detailLink, new RegExp(`/training/activity/${id}$`));
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
  await expect(page.getByTestId("training-log-reading-pane")).toHaveCount(0);
});

// The deep link has to do TWO things that nothing else in the suite exercises
// (TrainingLogView's hash effect): page older history in until the target row
// exists, then scroll it into view. Both halves need care to assert at all.
//
// The target is deliberately an activity the FIRST PAGE DOES NOT RENDER. Reading
// the id off a plain, hash-less load — which is what this test used to do — picks a
// row that is in the DOM either way, so the whole hash machinery could be deleted
// and the test would still pass (#3172 F1).
//
// And `toBeVisible()` is "non-empty bounding box", NOT viewport intersection, so it
// cannot tell a scrolled-to row from one sitting a thousand pixels below the fold.
// The position assertion below is the only thing here that speaks about scrolling.
test("an #activity-N deep link pages older history in and scrolls the row into view", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const rows = page.getByTestId("training-log-row");
  await expect(rows.first()).toBeVisible(); // first-ok: presence gate before reading ids
  // Everything the first window renders — the feed opens on 14 days.
  const firstPage = new Set(
    await rows.evaluateAll((els) => els.map((el) => el.id))
  );

  const db = new Database(workerDbPath(), { readonly: true });
  let targetId: number;
  try {
    db.pragma("busy_timeout = 5000");
    // The NEWEST activity the opening window does not render — i.e. the top of
    // the next page down. Deliberately not the profile's oldest row: the point is
    // to sit outside the rendered window, and the furthest-back row would also
    // depend on how deep the server feed pages, which is a different contract.
    const newestFirst = db
      .prepare(
        "SELECT id FROM activities WHERE profile_id = 1 ORDER BY date DESC, id DESC"
      )
      .all() as { id: number }[];
    const pick = newestFirst.find((a) => !firstPage.has(`activity-${a.id}`));
    // If the seed ever stops carrying more history than one page, this test
    // stops being able to prove anything — so it says so out loud rather than
    // passing on a target that was already loaded. That silent degradation is
    // the exact failure #3172 was filed about.
    expect(
      pick,
      "the seed must carry activity history beyond the opening window for this test to mean anything"
    ).toBeDefined();
    targetId = pick!.id;
  } finally {
    db.close();
  }

  await page.goto("about:blank");
  await page.goto(`/training?tab=log#activity-${targetId}`);
  const target = page.locator(`#activity-${targetId}`);

  // PRESENCE is the paging assertion: this row is below the opening window, so
  // it can only be here because the hash effect paged older history in.
  await expect(target).toBeVisible();
  await expect(
    target.getByRole("link").first() // first-ok: the canonical title link precedes any exercise links in the uniquely identified row
  ).toHaveAttribute("href", `/training/activity/${targetId}`);

  // POSITION is the scroll assertion. The jump is smooth-scrolled, so poll the
  // box rather than reading it once.
  const viewport = page.viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        return box != null && box.y >= 0 && box.y < viewport.height;
      },
      { message: "the deep-linked row must be scrolled into the viewport" }
    )
    .toBe(true);
});

test("phone rows use the same canonical destination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");
  const row = page.getByTestId("training-log-row").first(); // first-ok: any row proves the shared destination
  const id = (await row.getAttribute("id"))!.replace("activity-", "");

  await followLink(
    page,
    row.getByRole("link").first(), // first-ok: the canonical title link precedes any exercise links in the row
    new RegExp(`/training/activity/${id}$`)
  );
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(page.getByTestId("activity-record-body")).toBeVisible();
});
