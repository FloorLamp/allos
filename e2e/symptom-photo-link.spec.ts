import { test, expect } from "./fixtures";
import { randomBytes } from "node:crypto";
import { loginAs } from "./nav";
import {
  followLink,
  settledClick,
  settledFill,
  settledSelect,
  settledUpload,
} from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_SICK_PHOTO } from "./fixture-logins";

// #1093 — the symptom↔photo cross-link, end to end. This OWNS a dedicated sick-solo login
// (seed-events.ts) whose open episode has cough + fever logged today, so its cockpit's
// photo strip offers a "Symptom (optional)" selector. The spec attaches a photo TAGGED to
// a specific symptom and proves the photo binds to that log: since #1844 the symptom is
// the photo's SERIES in the shared gallery, so the binding shows as a series chip and in
// the lightbox beside the date. Isolated so its exact-count / delete-all photo assertions
// never race the shared profile-1 episode the round3 spec drives.
//
// A real 8x8 PNG, synthetic (no PHI). It must genuinely DECODE: since #1844 this domain's
// upload runs through processPhoto, and the 1x1 fixture this spec used to carry only ever
// had to pass a magic-byte sniff. Salting it is also pointless now — the content hash is
// taken over PROCESSED bytes, so trailing garbage no longer makes a distinct row and only
// different PIXELS would. What keeps a retry / --repeat-each iteration deterministic is
// the discipline below: the strip is emptied FIRST, so the hash this upload produces is
// guaranteed free.
const PHOTO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOo0DiBFTEMLQkAFtVaATzGqpoAAAAASUVORK5CYII=",
  "base64"
);

test.describe("Symptom photo ↔ log link (#1093)", () => {
  test("a photo tagged to a symptom shows that symptom on the episode cockpit", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SICK_PHOTO,
      password: E2E_MEMBER_PASSWORD,
    });

    // Reach this fixture's OWN open episode through its index (it owns exactly one).
    await page.goto("/medical/episodes");
    const episodeLink = page
      .getByTestId("episode-index-row")
      .filter({ hasText: /ongoing/i })
      .first(); // first-ok: spec-owned fixture with a single ongoing episode — order-agnostic
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    const strip = page.getByTestId("symptom-photo-strip");
    await expect(strip).toBeVisible();

    // The selector lists the symptoms logged today (cough + fever from the seed).
    const symptomSelect = strip.getByTestId("symptom-photo-symptom-select");
    await expect(symptomSelect).toBeVisible();
    await expect(
      symptomSelect.getByRole("option", { name: "Cough" })
    ).toHaveCount(1);

    // Photos live in the shared gallery since #1844: the grid shows pixels and each
    // photo's own controls live on its lightbox, so a delete is open-tile → delete →
    // watch the grid shrink (the illness-round3 pattern).
    const tiles = strip.locator('[data-testid^="photo-gallery-item-"]');
    const lightbox = page.getByTestId("photo-lightbox");

    async function emptyTheStrip() {
      for (let remaining = await tiles.count(); remaining > 0; remaining--) {
        await tiles.first().click(); // first-ok: loop deletes EVERY photo on a spec-owned episode — order-agnostic
        await expect(lightbox).toBeVisible();
        await settledClick(
          page,
          lightbox.locator('[data-testid^="symptom-photo-delete-"]')
        );
        await expect(tiles).toHaveCount(remaining - 1, { timeout: 15_000 });
      }
    }

    // OWN the strip state: clear any leftover photo so the tagged upload is unambiguous.
    await emptyTheStrip();

    const captionInput = strip.getByLabel("Caption (optional)");
    const caption = `Cough photo ${randomBytes(4).toString("hex")}`;

    // Tag the photo to "cough" and upload. This was a 45s upload-until-applied
    // `toPass` loop because settledUpload's arm accepted ANY same-origin POST and
    // this page fires unrelated ones, so a satisfied settle did not prove the upload
    // landed. #1952 made that wait correlate with the upload's own Server Action, so
    // the settle IS the signal and the re-drive is gone — a retry loop that re-fires
    // the write it is waiting on is the #1400 self-racing shape, kept only while
    // nothing better existed.
    //
    // Both fields are CONTROLLED (`value={photoSymptom}` / `value={caption}`), and
    // it was the loop, not the raw calls, that was rescuing a pre-hydration swallow
    // (#1941) — so they take the settled forms now that there is no second attempt.
    await settledSelect(page, symptomSelect, "cough");
    await settledFill(page, captionInput, caption);
    await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
      name: `cough-${randomBytes(6).toString("hex")}.png`,
      mimeType: "image/png",
      buffer: PHOTO_PNG,
    });
    await expect(tiles).toHaveCount(1, { timeout: 15_000 });

    await expect(page.getByText("Photo attached.")).toBeVisible();

    // THE payoff, on the surface that carries it since #1844: the symptom_log_id link
    // is the photo's SERIES. The gallery derives its series chips from the photos
    // themselves, so a chip labelled "Cough" existing at all means this photo bound to
    // that symptom log — and the lightbox names it beside the date, with the caption.
    await expect(strip.getByTestId("photo-gallery-series-cough")).toHaveText(
      "Cough"
    );
    await tiles.first().click(); // first-ok: the strip was emptied above, so this is the only tile
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toContainText("Cough");
    await expect(lightbox).toContainText(caption);
    await lightbox.getByTestId("photo-lightbox-close").click();
    await expect(lightbox).toHaveCount(0);

    // The reverse payoff: the episode cockpit gathers cough as one of its symptoms.
    await expect(
      page.getByTestId("symptom-log-bar").first() // first-ok: spec-owned fixture's own symptom bar — order-agnostic
    ).toContainText("Cough");

    // Clean up every photo we added so a re-run starts where it began.
    await emptyTheStrip();
    await expect(tiles).toHaveCount(0);
  });
  // #2124 — the same link, from the other end: what happens when the symptom-DAY the
  // photo is bound to is removed. The bar's × was a one-tap delete with no confirm and
  // no undo that unlinked the photo FILES on its way out, so a mis-tap destroyed a rash
  // series a caregiver took to show a doctor. It is a capture now: the photo rows travel
  // with the day and the files stay on disk until the trash window expires, so Undo puts
  // the whole series back re-pointed at the restored log.
  test("clearing a symptom-day takes its photos — and Undo brings the series back", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SICK_PHOTO,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/medical/episodes");
    const episodeLink = page
      .getByTestId("episode-index-row")
      .filter({ hasText: /ongoing/i })
      .first(); // first-ok: spec-owned fixture with a single ongoing episode — order-agnostic
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    const strip = page.getByTestId("symptom-photo-strip");
    await expect(strip).toBeVisible();
    const tiles = strip.locator('[data-testid^="photo-gallery-item-"]');
    const lightbox = page.getByTestId("photo-lightbox");

    // OWN the strip state (the sibling test's discipline): empty it first, so the tile
    // counts below are this test's own and the upload's content hash is free.
    async function emptyTheStrip() {
      for (let remaining = await tiles.count(); remaining > 0; remaining--) {
        await tiles.first().click(); // first-ok: loop deletes EVERY photo on a spec-owned episode — order-agnostic
        await expect(lightbox).toBeVisible();
        await settledClick(
          page,
          lightbox.locator('[data-testid^="symptom-photo-delete-"]')
        );
        await expect(tiles).toHaveCount(remaining - 1, { timeout: 15_000 });
      }
    }
    await emptyTheStrip();

    // A photo bound to the cough symptom-day — the row the delete has to carry.
    await settledSelect(
      page,
      strip.getByTestId("symptom-photo-symptom-select"),
      "cough"
    );
    await settledFill(
      page,
      strip.getByLabel("Caption (optional)"),
      `Undo probe ${randomBytes(4).toString("hex")}`
    );
    await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
      name: `undo-${randomBytes(6).toString("hex")}.png`,
      mimeType: "image/png",
      buffer: PHOTO_PNG,
    });
    await expect(tiles).toHaveCount(1, { timeout: 15_000 });
    await expect(strip.getByTestId("photo-gallery-series-cough")).toHaveText(
      "Cough"
    );

    // Clear the symptom-day. The photo goes with it — and the Undo affordance appears,
    // which the bar renders only when the action came back holding a capture token.
    const bar = page.getByTestId("symptom-log-bar").first(); // first-ok: spec-owned fixture's own symptom bar — order-agnostic
    await settledClick(page, bar.getByTestId("symptom-cough-clear"));
    await expect(page.getByText("Symptom removed.")).toBeVisible();
    await expect(tiles).toHaveCount(0, { timeout: 15_000 });

    await settledClick(page, page.getByRole("button", { name: "Undo" }));
    await expect(page.getByText("Restored.")).toBeVisible();

    // The payoff, after a reload so nothing here is an optimistic chip: the day is back,
    // its photo is back, and the photo is bound to the RESTORED log (the series chip is
    // derived from that link, so its presence is the link's presence — the row was
    // re-pointed at the new id, and the file underneath was never unlinked).
    await page.reload();
    const stripAfter = page.getByTestId("symptom-photo-strip");
    await expect(
      stripAfter.locator('[data-testid^="photo-gallery-item-"]')
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(
      stripAfter.getByTestId("photo-gallery-series-cough")
    ).toHaveText("Cough");
    await expect(
      page.getByTestId("symptom-log-bar").first() // first-ok: spec-owned fixture's own symptom bar — order-agnostic
    ).toContainText("Cough");

    // Clean up every photo we added so a re-run starts where it began.
    await emptyTheStrip();
    await expect(
      page
        .getByTestId("symptom-photo-strip")
        .locator('[data-testid^="photo-gallery-item-"]')
    ).toHaveCount(0);
  });
});

