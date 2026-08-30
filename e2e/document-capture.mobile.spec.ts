import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  capturePhotoFile,
  hydratedClick,
  primeCameraFallback,
  settledClick,
} from "./helpers";
import { workerDbPath } from "./worker-env";

// The phone shape of the medical-document upload (#1993, redrawn by #3286).
//
// The camera path used to render as "Or photograph a paper document:" plus a bare
// `<input type="file">` under a dashed drop zone — form-field grammar for what is a
// second way IN, sitting beneath a desktop metaphor that does nothing on touch. It
// then became two equal buttons below `sm`, and is now ONE DOOR on every width: the
// form mounts <MediaInput>, the shared add-media surface, which offers the picker
// and the camera side by side inside its dialog and orders them by device.
//
// THE INVARIANT THIS FILE EXISTS FOR IS UNCHANGED and is now stronger: everything
// rides ONE submit under exactly ONE `file` field, which is asserted directly here
// rather than inferred. The old form kept two inputs — a picker plus an image-only
// camera input — precisely because a `capture` attribute on an input that also
// accepts PDFs and zips makes mobile Chrome open the camera INSTEAD of the file
// picker, taking health-record exports off the phone. The shared surface removes
// that hazard at the root: its camera is a live viewfinder, not a `capture`
// attribute, so one input can accept everything and no `capture` is needed at all.
//
// The viewfinder is unavailable in a headless browser with no camera, so these
// drive the file path; the ordering itself (camera-first on a phone, chooser-first
// on a desktop) is e2e/media-input.spec.ts's subject.

const PREFIX = "e2e-doccam-";
// The name MediaInput hands back for a document capture.
const CAPTURED_NAME = "document.jpg";
const DB_PATH = workerDbPath();

// A 1x1 PNG — stand-in for a photographed page. It is re-encoded client-side
// before it reaches the input, which is the point: the bytes that get uploaded
// carry no EXIF.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function csv(i: number) {
  return {
    name: `${PREFIX}${i}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `metric,value,unit,date\nGlucose,${90 + i},mg/dL,2026-01-0${i}\n`
    ),
  };
}

test.describe("Document capture on a phone (issue #1993)", () => {
  // This spec owns its rows, and clears them after EVERY test rather than after the
  // file: the uploads are byte-stable, so under --repeat-each a leftover row would
  // content-hash dedupe the next repeat's upload into a restore instead of an
  // ingest. A raw connection (not lib/db) avoids re-running migrate()/bootstrap.
  test.afterEach(() => {
    const handle = new Database(DB_PATH);
    try {
      handle
        .prepare(
          "DELETE FROM medical_documents WHERE filename LIKE ? OR filename = ?"
        )
        .run(`${PREFIX}%`, CAPTURED_NAME);
    } finally {
      handle.close();
    }
  });

  test("one door on a phone, and the file and camera ways in sit together", async ({
    page,
  }) => {
    await primeCameraFallback(page);
    await page.goto("/data?section=import");

    // ONE FIELD, asserted rather than inferred. This form used to carry two file
    // inputs and the whole spec was arranged around keeping them apart.
    await expect(page.locator('form input[type="file"]')).toHaveCount(1);

    // Naming the drop gesture on a phone would be instructions for a device the
    // reader is not holding — the door is still one tap either way.
    const door = page.getByTestId("medical-upload-choose");
    await expect(door).toBeVisible();
    await expect(door).not.toContainText("drop");

    await hydratedClick(page, door);
    // Both ways in, in one place. The camera is a peer of the picker here, not a
    // sibling button in a row the desktop never sees.
    await expect(page.getByTestId("media-input-choose")).toBeVisible();
    await expect(page.getByTestId("media-input-camera")).toBeVisible();
    // And nothing has said a word about permissions, because nothing has tried
    // the camera yet (#3286).
    await expect(page.getByTestId("media-input-camera-error")).toHaveCount(0);
  });

  test("a photographed page rides the one submit under the one file field", async ({
    page,
  }) => {
    // The absent camera is a STATED precondition, not an assumed one (#2662):
    // it fixes WHICH stage the dialog opens on, so the walk below is decided
    // with no async input anywhere.
    await primeCameraFallback(page);
    await page.goto("/data?section=import");

    const input = page.getByTestId("medical-upload-input");
    await capturePhotoFile(page, page.getByTestId("medical-upload-choose"), {
      name: `${PREFIX}snap.png`,
      mimeType: "image/png",
      buffer: PNG_1X1,
    });

    // NO `capture` ATTRIBUTE ANYWHERE, which is what lets this single input
    // accept PDFs, zips and spreadsheets on a phone: `capture` would make mobile
    // Chrome open the camera instead of the file picker.
    await expect(input).not.toHaveAttribute("capture", /.*/);
    await expect(input).toHaveAttribute("accept", /image\/\*/);
    await expect(input).toHaveAttribute("accept", /\.pdf/);

    await expect(input).toHaveClass(/sr-only/);
    await expect(page.getByTestId("media-input-preview-0")).toBeVisible();
    // Confirming posts NOTHING — it hands the File to the form, which stores it in
    // the real input. The single submit comes later, which is the invariant.
    await hydratedClick(page, page.getByTestId("media-input-submit"));

    // The captured file landed in the SELECTED list, i.e. in the real `file` input —
    // there is no second form and no second submit.
    await expect(page.getByTestId("medical-upload-selected")).toContainText(
      CAPTURED_NAME
    );
    await settledClick(page, page.getByTestId("medical-upload-submit"));
    await expect(page.getByText("Upload received")).toBeVisible();

    await page.goto("/data?section=review");
    await expect(
      page.getByTestId("import-feed").getByText(CAPTURED_NAME)
    ).toBeVisible();
  });

  test("the door opens the picker and still takes several files at once", async ({
    page,
  }) => {
    // Proving the picker OPENS is what makes the offscreen input an
    // implementation detail rather than a regression, and multi-file (#1008)
    // survives the redesign: the chooser is still `multiple`, and the batch is
    // now listed per file inside the dialog before it is committed.
    await primeCameraFallback(page);
    await page.goto("/data?section=import");
    const trigger = page.getByTestId("medical-upload-choose");
    await expect(trigger).toBeVisible();
    await hydratedClick(page, trigger);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("media-input-choose").click(),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([csv(1), csv(2)]);

    const staged = page.getByTestId("media-input-selected");
    await expect(staged).toContainText(`${PREFIX}1.csv`);
    await expect(staged).toContainText(`${PREFIX}2.csv`);
    await expect(page.getByTestId("media-input-submit")).toHaveText(
      "Add 2 files"
    );
    await hydratedClick(page, page.getByTestId("media-input-submit"));

    const selected = page.getByTestId("medical-upload-selected");
    await expect(selected).toContainText(`${PREFIX}1.csv`);
    await expect(selected).toContainText(`${PREFIX}2.csv`);

    await settledClick(page, page.getByTestId("medical-upload-submit"));
    await expect(page.getByText("2 uploads received")).toBeVisible();
  });
});
