import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { loginAs } from "./nav";
import { followLink, settledClick, settledUpload } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_SICK_PHOTO } from "./fixture-logins";

// #1093 — the symptom↔photo cross-link, end to end. This OWNS a dedicated sick-solo login
// (seed-events.ts) whose open episode has cough + fever logged today, so its cockpit's
// photo strip offers a "Symptom (optional)" selector. The spec attaches a photo TAGGED to
// a specific symptom and proves the photo binds to that log: the thumbnail renders the
// symptom's label chip. Isolated so its exact-count / delete-all photo assertions never
// race the shared profile-1 episode the round3 spec drives. A salted 1x1 PNG is synthetic
// (no PHI); per-profile content-hash dedup (migration 049) needs the unique bytes so a
// retry / --repeat-each iteration is a genuinely new row, not a silent no-op.

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQBHYh4RAAAAAElFTkSuQmCC",
  "base64"
);

function uniquePng(): Buffer {
  return Buffer.concat([PNG_1x1, randomBytes(16)]);
}

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

    const deleteButtons = strip.locator(
      '[data-testid^="symptom-photo-delete-"]'
    );
    // OWN the strip state: clear any leftover photo so the tagged upload is unambiguous.
    for (
      let remaining = await deleteButtons.count();
      remaining > 0;
      remaining--
    ) {
      await settledClick(page, deleteButtons.first()); // first-ok: loop deletes EVERY photo on a spec-owned episode — order-agnostic
      await expect(deleteButtons).toHaveCount(remaining - 1, {
        timeout: 15_000,
      });
    }

    const captionInput = strip.getByLabel("Caption (optional)");
    const caption = `Cough photo ${randomBytes(4).toString("hex")}`;

    // Tag the photo to "cough" and upload. settledUpload's POST arm matches any
    // same-origin POST and this page fires unrelated revalidations, so re-drive until a
    // tagged thumbnail actually renders (only an applied upload adds a delete button).
    await expect(async () => {
      await symptomSelect.selectOption("cough");
      await captionInput.fill(caption);
      await settledUpload(page, strip.getByTestId("symptom-photo-input"), {
        name: `cough-${randomBytes(6).toString("hex")}.png`,
        mimeType: "image/png",
        buffer: uniquePng(),
      });
      await expect(deleteButtons.first()).toBeVisible({ timeout: 5_000 }); // first-ok: asserts a photo delete button rendered before the assertions below — order-agnostic
    }).toPass({ timeout: 45_000 }); // topass-ok: upload-until-applied — only an actually-applied photo renders a delete button, so this can't false-pass; a double-land is absorbed by the delete-all cleanup

    await expect(page.getByText("Photo attached.")).toBeVisible();

    // THE payoff: the tagged photo carries its symptom's label chip (the symptom_log_id
    // link surfaced) — not just a bare day photo.
    const taggedPhoto = strip
      .locator("figure")
      .filter({ hasText: caption })
      .last();
    const testId = await taggedPhoto.getAttribute("data-testid");
    expect(testId).toMatch(/^symptom-photo-\d+$/);
    const photoId = testId!.replace("symptom-photo-", "");
    await expect(
      taggedPhoto.getByTestId(`symptom-photo-symptom-${photoId}`)
    ).toHaveText("Cough");

    // The reverse payoff: the episode cockpit gathers cough as one of its symptoms.
    await expect(
      page.getByTestId("symptom-log-bar").first() // first-ok: spec-owned fixture's own symptom bar — order-agnostic
    ).toContainText("Cough");

    // Clean up every photo we added so a re-run starts where it began.
    for (
      let remaining = await deleteButtons.count();
      remaining > 0;
      remaining--
    ) {
      await settledClick(page, deleteButtons.first()); // first-ok: loop deletes EVERY photo on a spec-owned episode — order-agnostic
      await expect(deleteButtons).toHaveCount(remaining - 1, {
        timeout: 15_000,
      });
    }
    await expect(deleteButtons).toHaveCount(0);
  });
});
