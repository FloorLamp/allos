import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { followLink, settledClick, settledUpload } from "./helpers";
import { openTempEntry } from "./symptom-helpers";

// Illness round 3 (#859). The seed makes profile 1 currently sick with an OPEN "Illness"
// episode, so these drive the NEW episode-page surfaces on that shared open episode with
// additive writes only (no exact-count assertions on the shared seed — the #868 hygiene
// rule): the single-reading temperature red-flag toast + care line (item 3), the
// school-return countdown line that appears once a fever is logged (item 2), and the
// symptom-photo strip (item 4). A 1x1 PNG is a synthetic fixture (no PHI).

// Smallest valid PNG (1x1 transparent), base64 — a synthetic fixture image.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBHYh4RAAAAAElFTkSuQmCC",
  "base64"
);

// A valid 1x1 PNG whose bytes are UNIQUE per call: a PNG decoder stops at the IEND
// chunk, so random trailing bytes leave a perfectly valid image while changing its
// content hash. This is the load-bearing #907 fix — `symptom_photos` dedups
// per-profile on `content_hash` (migration 049's partial UNIQUE index), so a retry
// (or a --repeat-each iteration) that re-uploaded the byte-identical fixture was a
// silent no-op, and `toHaveCount(before + 1)` could then NEVER pass. Salting the
// payload makes every upload a genuinely new row.
function uniquePng(): Buffer {
  return Buffer.concat([PNG_1x1, randomBytes(16)]);
}

test.describe("Illness round 3 (#859)", () => {
  test("red-flag + school-return + photo strip on the episode page", async ({
    page,
  }) => {
    test.slow();

    // Reach the open episode via the illness hero cockpit's "Full episode" link.
    await page.goto("/");
    const episodeLink = page
      .getByRole("link", { name: "Full episode", exact: true })
      .first();
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    const bar = page.getByTestId("symptom-log-bar").first();

    // Item 3: log a very high fever (104.5°F) — the source's cited single-reading
    // red-flag instruction fires inline at logging (any age).
    await openTempEntry(bar);
    await bar.getByTestId("temp-quick-unit").selectOption("F");
    await bar.getByTestId("temp-quick-input").fill("104.5");
    await bar.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/Temperature logged/i)).toBeVisible();
    await expect(page.getByText(/contact a clinician/i)).toBeVisible();

    // Item 2: once a fever-range reading exists, the school-return countdown line
    // renders (it reflows after the log's router.refresh()).
    await expect(page.getByTestId("school-return-line")).toBeVisible();
    await expect(page.getByTestId("school-return-line")).toContainText(
      /Fever-free/i
    );

    // Item 4: attach a symptom photo via the camera-first input, then see it in the
    // dated strip.
    const strip = page.getByTestId("symptom-photo-strip");
    await expect(strip).toBeVisible();
    // Count photos by their per-photo delete button (one per attached photo), so the
    // always-present input/add controls don't inflate the count.
    const deleteButtons = strip.locator(
      '[data-testid^="symptom-photo-delete-"]'
    );

    // OWN the whole strip state (#907): delete EVERY existing photo so `before` is a
    // deterministic 0 and no leftover from a failed attempt / prior --repeat-each
    // iteration can poison the count. settledClick awaits each delete's Server-Action
    // POST, so the count-drop assertion runs against the applied state, not a race.
    for (
      let remaining = await deleteButtons.count();
      remaining > 0;
      remaining--
    ) {
      await settledClick(page, deleteButtons.first());
      await expect(deleteButtons).toHaveCount(remaining - 1, {
        timeout: 15_000,
      });
    }

    // Upload a uniquely-salted PNG and await the upload Server-Action POST before
    // asserting the new thumbnail (settledUpload replaces the bare 15s count poll).
    await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
      name: "rash.png",
      mimeType: "image/png",
      buffer: uniquePng(),
    });
    await expect(deleteButtons).toHaveCount(1, { timeout: 15_000 });

    // Clean up the photo we added so a re-run starts where it began.
    await settledClick(page, deleteButtons.last());
    await expect(deleteButtons).toHaveCount(0, { timeout: 15_000 });
  });
});
