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

    // Reach the acting profile's open episode through its own index. The dashboard can
    // contain other household members' episode links after earlier stress-lane specs
    // create profiles, so a page-global first-match would make this test order-dependent.
    await page.goto("/medical/episodes");
    const episodeLink = page
      .getByTestId("episode-index-row")
      .filter({ hasText: /ongoing/i })
      .first(); // first-ok: the acting profile's own ongoing episode via its index (see comment) — order-agnostic
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: the acting profile's own symptom bar — order-agnostic

    // Item 3: log a very high fever (104.5°F) — the source's cited single-reading
    // red-flag instruction fires inline at logging (any age).
    await openTempEntry(bar);
    await bar.getByTestId("temp-quick-unit").selectOption("F");
    await bar.getByTestId("temp-quick-input").fill("104.5");
    await bar.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/Temperature logged/i)).toBeVisible();
    await expect(page.getByText(/contact a clinician/i)).toBeVisible();

    // Item 2: once a fever-range reading exists, a compact school-return status
    // joins the latest temperature and medication row (after router.refresh()).
    const feverFreeStatus = page.getByTestId("school-return-status");
    await expect(feverFreeStatus).toBeVisible();
    await expect(feverFreeStatus).toContainText(/Fever-free \d+h\/\d+h/i);
    await expect(feverFreeStatus).toHaveClass(/text-slate-500/);
    const latestReadings = page.getByTestId("episode-latest-readings");
    await expect(
      latestReadings.getByTestId("school-return-status")
    ).toBeVisible();
    const temperatureBox = await latestReadings
      .getByTestId("episode-last-temperature")
      .boundingBox();
    const feverFreeBox = await feverFreeStatus.boundingBox();
    expect(
      Math.abs((temperatureBox?.y ?? 0) - (feverFreeBox?.y ?? 0))
    ).toBeLessThan(24);

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
      await settledClick(page, deleteButtons.first()); // first-ok: loop deletes EVERY photo; first-of-remaining is order-agnostic
      await expect(deleteButtons).toHaveCount(remaining - 1, {
        timeout: 15_000,
      });
    }

    // The logging-area shortcut points to the SAME hidden camera input owned by the
    // gallery. Upload a uniquely-salted PNG through that input and re-drive until a
    // thumbnail renders.
    const addPhotoShortcut = page.getByTestId("episode-add-photo-shortcut");
    await expect(addPhotoShortcut).toHaveAttribute(
      "for",
      "episode-symptom-photo-input"
    );
    const captionInput = strip.getByLabel("Caption (optional)");

    // settledUpload's POST arm matches ANY same-origin POST, and this page fires
    // unrelated posts (earlier steps' revalidations, the offline-queue flush), so
    // a satisfied settle doesn't prove the UPLOAD landed — CI hit exactly that
    // (settle resolved, 0 thumbnails for 15s). toPass is justified (a commented
    // last resort): only an actually-applied upload renders a delete button, so
    // the loop cannot false-pass; a re-driven attempt that double-lands is
    // absorbed by the delete-ALL cleanup below.
    await expect(async () => {
      await captionInput.fill("Rash on left forearm");
      await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
        name: `rash-${randomBytes(6).toString("hex")}.png`,
        mimeType: "image/png",
        buffer: uniquePng(),
      });
      await expect(deleteButtons.first()).toBeVisible({ timeout: 5_000 }); // first-ok: asserts a photo delete button renders before the delete loop — order-agnostic
    }).toPass({ timeout: 45_000 });

    await expect(page.getByText("Photo attached.")).toBeVisible();
    const captionedPhoto = strip
      .locator("figure")
      .filter({ hasText: "Rash on left forearm" })
      .last();
    const addedPhotoTestId = await captionedPhoto.getAttribute("data-testid");
    expect(addedPhotoTestId).toMatch(/^symptom-photo-\d+$/);
    const addedPhoto = strip.locator(`[data-testid="${addedPhotoTestId}"]`);
    await expect(addedPhoto).toContainText("Rash on left forearm");

    // Existing captions can be corrected without replacing the image.
    await addedPhoto
      .getByRole("button", { name: "Edit photo caption" })
      .click();
    const captionEditor = addedPhoto.getByLabel("Photo caption", {
      exact: true,
    });
    await captionEditor.fill("Rash improving");
    await addedPhoto.getByRole("button", { name: "Save" }).click();
    await expect(addedPhoto).toContainText("Rash improving", {
      timeout: 15_000,
    });
    // Clean up every photo we added (a re-driven upload may have landed twice) so
    // a re-run starts where it began.
    for (
      let remaining = await deleteButtons.count();
      remaining > 0;
      remaining--
    ) {
      await settledClick(page, deleteButtons.first()); // first-ok: loop deletes EVERY photo; first-of-remaining is order-agnostic
      await expect(deleteButtons).toHaveCount(remaining - 1, {
        timeout: 15_000,
      });
    }
    await expect(deleteButtons).toHaveCount(0);
  });
});
