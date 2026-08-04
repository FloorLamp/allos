import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

// PWA share target (issue #1423). The phone's share sheet POSTs a multipart body
// to /share-target; this spec drives that POST against the REAL running app with
// the suite's authenticated storage state (page.request shares the browser
// context's cookies), and asserts the shared file round-trips into a stored
// medical document — landing on its detail page, where the "Wrong person?"
// reassign control is the correction affordance for the profile a share sheet
// can't pick. It also pins the manifest registration and the desktop shape of the
// upload form the share sheet is the phone-side alternative to.
//
// Fixtures are synthetic and AI-free: an EMPTY, fictional FHIR bundle imports
// DETERMINISTICALLY (no ANTHROPIC_API_KEY needed, no background extraction race,
// no imported rows to clean up) and settles at a terminal status before the POST
// response returns — so the detail page is fully rendered on arrival. No PHI.

// Unique prefix so cleanup targets exactly this spec's rows and the shared e2e DB
// stays clean for the neighbors (review-inbox / import-dedup assert feed counts).
const PREFIX = "e2e-share-";
const DB_PATH = workerDbPath();

function bundle(salt: string) {
  return {
    name: `${PREFIX}${salt}.json`,
    mimeType: "application/fhir+json",
    buffer: Buffer.from(
      JSON.stringify({
        resourceType: "Bundle",
        type: "collection",
        id: `${PREFIX}${salt}`,
        entry: [],
      })
    ),
  };
}

test.describe("PWA share target (issue #1423)", () => {
  // This spec creates medical_documents rows; remove them afterward. A raw
  // connection (not lib/db) avoids re-running migrate()/bootstrap on import.
  test.afterAll(() => {
    const handle = new Database(DB_PATH);
    try {
      handle
        .prepare("DELETE FROM medical_documents WHERE filename LIKE ?")
        .run(`${PREFIX}%`);
    } finally {
      handle.close();
    }
  });

  test("the manifest registers /share-target for files", async ({ page }) => {
    const res = await page.request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.share_target).toMatchObject({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
    });
    // The field name must match the upload form's input, since both entry points
    // read formData.getAll("file").
    expect(manifest.share_target.params.files[0].name).toBe("file");
  });

  test("a shared file lands a stored document with the reassign affordance", async ({
    page,
  }) => {
    // The OS share sheet's POST, carrying this context's session cookie.
    const res = await page.request.post("/share-target", {
      multipart: { file: bundle("passport") },
    });
    // The 303 is followed as a GET onto the stored document's detail page.
    expect(res.status()).toBe(200);
    expect(res.url()).toMatch(/\/import\/\d+$/);

    await page.goto(res.url());
    await expect(
      page.getByRole("heading", { name: `${PREFIX}passport.json` })
    ).toBeVisible();
    // A share sheet can't pick a profile, so the landing page must make the
    // profile choice correctable in place.
    await expect(
      page.getByRole("heading", { name: "Wrong person?" })
    ).toBeVisible();
    await expect(page.getByTestId("reassign-dest")).toBeVisible();

    // …and it is a real document in the Review feed, not a one-off view.
    await page.goto("/data?section=review");
    await expect(
      page.getByTestId("import-feed").getByText(`${PREFIX}passport.json`)
    ).toBeVisible();
  });

  test("an anonymous share is dropped at the login page", async ({
    browser,
    baseURL,
  }) => {
    // A fresh context with NO storage state — the share sheet of a signed-out
    // phone. The response must be the login page (a 303 the browser follows as a
    // GET), never a 307 that re-POSTs the file at /login.
    // browser.newContext() does NOT inherit the project's `use` options, which is
    // exactly what we want for storageState — but it means baseURL has to be
    // passed through explicitly.
    const anon = await browser.newContext({ baseURL, storageState: undefined });
    try {
      const res = await anon.request.post("/share-target", {
        multipart: { file: bundle("anon") },
      });
      expect(res.status()).toBe(200);
      expect(new URL(res.url()).pathname).toBe("/login");
    } finally {
      await anon.close();
    }
  });

  test("the DESKTOP upload form keeps its drop zone and offers no camera path", async ({
    page,
  }) => {
    await page.goto("/data?section=import");

    // Drag-and-drop is a real gesture here, so the dashed zone stays (#1993).
    await expect(page.getByTestId("medical-upload-dropzone")).toBeVisible();
    await expect(page.getByTestId("medical-upload-choose")).toBeVisible();
    // `capture` does nothing useful on a desktop, so the camera action is not
    // rendered beside a working drop zone — it used to sit under it as a bare
    // "Choose File" row. The phone's two-button treatment is covered by
    // document-capture.mobile.spec.ts.
    await expect(page.getByTestId("medical-upload-camera")).toBeHidden();
    // And `capture` never migrated onto the MAIN picker: on an input that also
    // accepts PDFs/zips/spreadsheets, mobile Chrome opens the camera INSTEAD of
    // the file picker, which would take health-record exports off the phone.
    await expect(page.getByTestId("medical-upload-input")).not.toHaveAttribute(
      "capture",
      /.*/
    );
  });
});
