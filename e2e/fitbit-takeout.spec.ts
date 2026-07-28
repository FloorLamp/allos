import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// The Fitbit / Google Takeout integration page — the one `archive` provider. Unlike
// every other integration there is nothing to connect: the page is instructions plus
// a file picker, so the browser coverage is that it renders, is reachable from the
// Integrations index, and offers the upload control.
//
// The IMPORT itself is exercised end-to-end in the DB tier
// (lib/__db_tests__/fitbit-takeout-import.test.ts) against a real zip — driving a
// ~250 MB archive through a browser would be a fixture, not a test.
test.describe("Fitbit (Google Takeout) integration", () => {
  test("is listed on Integrations and links to its page", async ({ page }) => {
    await page.goto("/data?section=import");
    const link = page.getByRole("link", { name: /Fitbit \(Google Takeout\)/ });
    await expect(link).toBeVisible();
    await link.click();
    await expect(
      page.getByRole("heading", { name: "Fitbit (Google Takeout)" })
    ).toBeVisible();
  });

  test("explains how to get an export and offers the upload", async ({
    page,
  }) => {
    await page.goto("/integrations/fitbit-takeout");

    // The instructions are the substance of this page — without them the file
    // picker is unusable, since the export lives behind a Google flow.
    await expect(
      page.getByRole("heading", { name: "Get your export" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Google Takeout" })
    ).toHaveAttribute("href", "https://takeout.google.com/");

    const upload = page.getByTestId("takeout-upload");
    await expect(upload).toBeVisible();
    await expect(page.getByTestId("takeout-file")).toBeAttached();

    // Nothing imported yet for the seeded profile.
    await expect(page.getByTestId("takeout-status")).toContainText(
      /No archive imported yet|Last import/
    );

    // The vendor-score stance is stated on the page, not just in code: these are
    // Fitbit's numbers and feed nothing the app computes (#1069).
    await expect(
      page.getByText(/never used to compute anything else/)
    ).toBeVisible();
  });

  // Uploading the WRONG file is the likely mistake here — the export arrives as
  // several numbered parts and lives among other Takeout downloads — so the failure
  // message is a real surface, not an edge case. It used to be "internal error" (a
  // 500, which also filed a server error for every mistyped upload); an unreadable
  // archive is the caller's problem and now answers 400 with the reason.
  //
  // A junk zip is a legitimate browser fixture where a real one is not: the import
  // fails at the central-directory read, before any DB write, so this touches no
  // shared seed data and leaves nothing to clean up.
  test("a file that isn't a valid archive says so, rather than 'internal error'", async ({
    page,
  }) => {
    await page.goto("/integrations/fitbit-takeout");

    await page.getByTestId("takeout-file").setInputFiles({
      name: "not-really-an-export.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("PK\x03\x04 this is not a zip central directory"),
    });

    const error = page.getByTestId("takeout-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/not a valid zip archive/i);
    // The point of the change: the user is told what's wrong with THEIR file.
    await expect(error).not.toContainText(/internal error/i);

    // A rejected upload must not claim an import happened.
    await expect(page.getByTestId("takeout-result")).toHaveCount(0);

    // The attempt is attributable in Review, not just a transient browser error.
    // Remove only this spec-owned failure afterward so it cannot replace the seeded
    // successful Fitbit event for another spec sharing this worker database.
    const db = new Database(workerDbPath());
    let event: { id: number; error: string } | undefined;
    try {
      event = db
        .prepare(
          `SELECT id, error FROM integration_sync_events
            WHERE profile_id = 1 AND provider = 'fitbit-takeout' AND ok = 0
            ORDER BY id DESC LIMIT 1`
        )
        .get() as { id: number; error: string } | undefined;
      expect(event?.error).toMatch(/not a valid zip archive/i);
    } finally {
      if (event) {
        db.prepare(
          "DELETE FROM integration_sync_events WHERE id = ? AND profile_id = 1"
        ).run(event.id);
      }
      db.close();
    }
  });
});
