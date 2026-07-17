import { test, expect } from "@playwright/test";
import { followLink } from "./nav";
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
    // always-present input/add controls don't inflate the count. Start from a clean
    // slate (a prior --repeat-each iteration may have left one).
    const deleteButtons = strip.locator(
      '[data-testid^="symptom-photo-delete-"]'
    );
    const before = await deleteButtons.count();
    await strip.getByTestId("symptom-photo-input").setInputFiles({
      name: "rash.png",
      mimeType: "image/png",
      buffer: PNG_1x1,
    });
    // The upload Server Action re-renders the strip with the new thumbnail.
    await expect(deleteButtons).toHaveCount(before + 1, { timeout: 15_000 });
    // Clean up the photo we added so a re-run starts where it began.
    await deleteButtons.last().click();
    await expect(deleteButtons).toHaveCount(before, { timeout: 15_000 });
  });
});
