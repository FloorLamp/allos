import { expect, type Locator, type Page } from "@playwright/test";
import { LOG_SEGMENT_CENSUS } from "@/lib/log-sheet";
import type { QuickLogId } from "@/lib/quick-log";

// Driving the quick-log sheet's SEGMENTED long tail (issue #2651).
//
// The sheet used to be one flat list, so every spec reached a row by test id and
// got it. Since #2651 the long tail is a segmented domain track (Train · Food ·
// Body · Care) and a row exists in the DOM only while its own segment is
// selected — so "reach the row" now means "select its segment, then reach the
// row", and every caller has to say which.
//
// ── THE PRECONDITION IS ASSERTED, NOT TOLERATED ──────────────────────────────
//
// `showLogRow` fails if the track is absent, if the segment it needs is absent,
// or if the tap does not leave that segment reporting itself selected. The
// tempting alternative — "tap the segment if there is one, then look for the
// row" — would pass in BOTH worlds, which means the sheet could quietly stop
// segmenting and every spec in the suite would stay green. That is the
// `openAddPeriodPanel` discipline (e2e/cycle-helpers.ts): a helper that opens a
// thing asserts the closed state first, so it can never be a no-op.
//
// Which segment holds which row is read from the app's OWN census
// (`LOG_SEGMENT_CENSUS`) rather than restated here. Moving a row between
// segments is then a product decision that carries its specs with it, and a
// retired `QuickLogId` fails `tsc` at every call site.

/**
 * Open the quick-log sheet from the top bar's caret and return it.
 *
 * The caret is a pure CLIENT toggle, so a pre-hydration tap is swallowed with no
 * POST to settle on and no other awaitable open signal — the visibility-guarded
 * retry is the only honest wait here (#500/#830). Safe to repeat because the
 * trigger only ever sets TRUE.
 */
export async function openLogSheet(page: Page): Promise<Locator> {
  const sheet = page.getByTestId("quick-log-sheet");
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      await page.getByTestId("quick-log-more").click();
    }
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the caret past the pre-hydration swallow — a client toggle with no POST, visibility-guarded so a late tap can't re-close it
  return sheet;
}

/**
 * Select the segment holding `id` and return that row's locator.
 *
 * Returns a LOCATOR, deliberately, rather than asserting the row is visible: a
 * caller proving a row is GONE (the #1042 relevance gate) needs the segment
 * revealed and the row absent, which is a strictly stronger statement than the
 * flat sheet could make.
 */
export async function showLogRow(
  sheet: Locator,
  id: QuickLogId
): Promise<Locator> {
  const track = sheet.getByTestId("log-sheet-segments");
  await expect(track).toBeVisible();
  const segment = track.getByTestId(
    `log-sheet-segment-${LOG_SEGMENT_CENSUS[id]}`
  );
  await expect(segment).toBeVisible();
  await segment.click();
  await expect(segment).toHaveAttribute("aria-pressed", "true");
  return sheet.getByTestId(`quick-log-${id}`);
}
