import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// #2897 — the Log tab as the browse surface. Slim rows on the left; selecting
// a row renders the record in the aside's READING PANE — the same component
// the activity page renders (one derivation, three hosts) — with no
// navigation and no scroll loss. Phones get expand-in-place instead of a pane.

test("selecting rows swaps the pane in place: no navigation, scroll holds", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const rows = page.getByTestId("training-log-row");
  await expect(rows.first()).toBeVisible(); // first-ok: presence gate; specific rows are addressed below
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  const url = page.url();
  const firstId = (await rows.nth(0).getAttribute("id"))!.replace(
    "activity-",
    ""
  );
  const secondId = (await rows.nth(1).getAttribute("id"))!.replace(
    "activity-",
    ""
  );

  // First selection: the pane renders THAT record (the Open door names it).
  await rows.nth(0).click();
  const pane = page.getByTestId("training-log-reading-pane");
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId("activity-pane-open")).toHaveAttribute(
    "href",
    `/training/activity/${firstId}`
  );

  // Second selection: the pane SWAPS — still no navigation, and the list keeps
  // its scroll (the whole point of the pane over the full page for review).
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await rows.nth(1).click();
  await expect(pane.getByTestId("activity-pane-open")).toHaveAttribute(
    "href",
    `/training/activity/${secondId}`
  );
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  // The pane renders the record's own markup — the card body the activity page
  // also renders, not a fork.
  await expect(pane.getByTestId("activity-card-body")).toBeVisible();

  // "Open ↗" promotes to the full page, whose record is the same component.
  await followLink(
    page,
    pane.getByTestId("activity-pane-open"),
    new RegExp(`/training/activity/${secondId}$`)
  );
  await expect(
    page.getByTestId("training-activity-page").getByTestId("activity-card-body")
  ).toBeVisible();
});

test("an #activity-N deep link opens that row's record in the pane", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  const rows = page.getByTestId("training-log-row");
  await expect(rows.first()).toBeVisible(); // first-ok: presence gate before reading ids
  const targetId = (await rows.nth(1).getAttribute("id"))!.replace(
    "activity-",
    ""
  );

  // A fresh navigation with the hash — the immutable Telegram-era vocabulary.
  await page.goto(`/training?tab=log#activity-${targetId}`);
  const pane = page.getByTestId("training-log-reading-pane");
  await expect(pane.getByTestId("activity-pane-open")).toHaveAttribute(
    "href",
    `/training/activity/${targetId}`
  );
});

test("phone rows expand the record in place, and collapse again", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");
  const row = page.getByTestId("training-log-row").first(); // first-ok: any row proves the expand gesture
  await expect(row).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("activity-card-body").first()).toBeVisible(); // first-ok: the one expanded card

  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("activity-card-body")).toHaveCount(0);
});
