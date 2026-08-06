import { test, expect } from "./fixtures";
import { randomBytes } from "node:crypto";
import {
  followLink,
  settledClick,
  settledFill,
  settledUpload,
} from "./helpers";
import { openTempEntry } from "./symptom-helpers";

// Illness round 3 (#859). The seed makes profile 1 currently sick with an OPEN "Illness"
// episode, so these drive the NEW episode-page surfaces on that shared open episode with
// additive writes only (no exact-count assertions on the shared seed — the #868 hygiene
// rule): the single-reading temperature red-flag toast + care line (item 3), the
// school-return countdown line that appears once a fever is logged (item 2), and the
// symptom-photo strip (item 4). A tiny generated PNG is a synthetic fixture (no PHI).

// A tiny (8x8) solid PNG, base64 — a synthetic fixture image (no PHI). It must
// DECODE, not merely pass a magic-byte sniff: since #1844 a symptom photo goes
// through the shared photo core, which re-encodes it and strips its metadata.
//
// That also retires the #907 salt. `symptom_photos` still dedups per-profile on
// `content_hash`, but the hash is now taken over the PROCESSED bytes, so appending
// random trailing bytes (which a PNG decoder ignores) no longer makes a distinct
// row — only different PIXELS would. What keeps a retry / --repeat-each iteration
// deterministic instead is the discipline below: the strip is emptied FIRST, so the
// hash this upload will produce is guaranteed free.
const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOo0DiBFTEMLQkAFtVaATzGqpoAAAAASUVORK5CYII=",
  "base64"
);

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
    // shared photo gallery the strip renders since #1844 (browse grid + lightbox).
    const strip = page.getByTestId("symptom-photo-strip");
    await expect(strip).toBeVisible();
    // Count photos by their grid tiles, so the always-present input/add controls
    // don't inflate the count.
    const tiles = strip.locator('[data-testid^="photo-gallery-item-"]');
    const lightbox = page.getByTestId("photo-lightbox");

    // Delete every photo in the strip, whatever it holds. Each delete lives on the
    // photo's own lightbox, so a pass is: open the first tile, delete, watch the
    // grid shrink. settledClick awaits the delete's Server-Action POST, so the
    // count-drop assertion runs against the applied state, not a race.
    async function emptyTheStrip() {
      for (let remaining = await tiles.count(); remaining > 0; remaining--) {
        await tiles.first().click(); // first-ok: loop deletes EVERY photo; first-of-remaining is order-agnostic
        await expect(lightbox).toBeVisible();
        await settledClick(
          page,
          lightbox.locator('[data-testid^="symptom-photo-delete-"]')
        );
        await expect(tiles).toHaveCount(remaining - 1, { timeout: 15_000 });
      }
    }

    // OWN the whole strip state (#907): start from a deterministic 0 so no leftover
    // from a failed attempt / prior --repeat-each iteration can poison the count.
    await emptyTheStrip();

    // The logging-area shortcut points to the SAME hidden camera input owned by the
    // gallery. Upload a uniquely-salted PNG through that input.
    const addPhotoShortcut = page.getByTestId("episode-add-photo-shortcut");
    await expect(addPhotoShortcut).toHaveAttribute(
      "for",
      "episode-symptom-photo-input"
    );
    const captionInput = strip.getByLabel("Caption (optional)");

    // This was a 45s upload-until-applied `toPass` loop, and its comment said why:
    // settledUpload's arm matched ANY same-origin POST, and this page fires unrelated
    // ones (earlier steps' revalidations, the offline-queue flush to
    // /api/offline-replay), so a satisfied settle did not prove the UPLOAD landed —
    // CI hit exactly that, settle resolved and 0 thumbnails for 15s. #1952 made the
    // arm correlate with the upload's own Server Action (started after the
    // setInputFiles AND carrying next-action, which the /api flush by construction
    // does not), so the settle is now the signal and re-driving the write we are
    // waiting on — the #1400 self-racing shape — is no longer needed.
    //
    // The caption input is CONTROLLED (`value={caption}`); the loop was what
    // rescued a pre-hydration swallow (#1941), so the fill becomes settledFill.
    await settledFill(page, captionInput, "Rash on left forearm");
    await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
      name: `rash-${randomBytes(6).toString("hex")}.png`,
      mimeType: "image/png",
      buffer: PHOTO_PNG,
    });
    await expect(page.getByText("Photo attached.")).toBeVisible();
    await expect(tiles).toHaveCount(1, { timeout: 15_000 });

    // The caption rides with the photo: the grid shows pixels, the lightbox shows
    // what the person wrote about them.
    await tiles.first().click(); // first-ok: the strip was emptied above, so this is the only tile
    await expect(lightbox).toContainText("Rash on left forearm");

    // Existing captions can be corrected without replacing the image.
    await lightbox
      .getByRole("button", { name: "Edit caption", exact: true })
      .click();
    await settledFill(
      page,
      lightbox.getByLabel("Photo caption", { exact: true }),
      "Rash improving"
    );
    await settledClick(page, lightbox.getByRole("button", { name: "Save" }));
    await tiles.first().click(); // first-ok: still the only tile in the emptied strip
    await expect(lightbox).toContainText("Rash improving", {
      timeout: 15_000,
    });
    await lightbox.getByTestId("photo-lightbox-close").click();

    // Clean up every photo we added so a re-run starts where it began.
    await emptyTheStrip();
    await expect(tiles).toHaveCount(0);
  });
});
