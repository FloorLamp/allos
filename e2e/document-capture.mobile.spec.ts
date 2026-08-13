import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  capturePhotoFile,
  hydratedClick,
  primeCameraFallback,
  settledClick,
} from "./helpers";
import { workerDbPath } from "./worker-env";

// The phone shape of the medical-document upload (issue #1993).
//
// The camera path used to render as "Or photograph a paper document:" plus a bare
// `<input type="file">` under a dashed drop zone — form-field grammar for what is a
// second way IN, sitting beneath a desktop metaphor that does nothing on touch
// (there is no drag-and-drop on a phone). Below `sm` the form now offers TWO EQUAL
// buttons, Upload and Camera, and no drop zone at all.
//
// What must not change is the mechanism: the camera is image-only and separate from
// the picker (a `capture` attribute on an input that also accepts PDFs/zips makes
// mobile Chrome open the camera INSTEAD of the file picker, taking health-record
// exports off the phone), and everything rides ONE submit under the one `file`
// field. Both halves are asserted here.
//
// The camera opens <PhotoCapture> (#1119), whose getUserMedia preview falls back to
// a native input when the camera is unavailable or denied — which is exactly what
// happens in a headless browser with no camera permission, so this drives the
// fallback path the same way e2e/progress-photos.spec.ts does.

const PREFIX = "e2e-doccam-";
// The name PhotoCapture hands back for a document capture.
const CAPTURED_NAME = "document.jpg";
const DB_PATH = workerDbPath();

// A 1x1 PNG — stand-in for what a camera hands the form. It is re-encoded through
// PhotoCapture's canvas before it reaches the input, which is the point: the bytes
// that get uploaded carry no EXIF.
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

  test("offers Upload and Camera as two equal actions, with no drop zone", async ({
    page,
  }) => {
    await page.goto("/data?section=import");

    // No drag-and-drop on touch, so the dashed box is desktop-only.
    await expect(page.getByTestId("medical-upload-dropzone")).toBeHidden();

    const upload = page.getByTestId("medical-upload-choose-mobile");
    const camera = page.getByTestId("medical-upload-camera");
    await expect(upload).toBeVisible();
    await expect(camera).toBeVisible();

    // EQUAL weight: photographing the page in front of you and picking a file out
    // of Drive are equally likely on a phone, so neither is the small one.
    const uploadBox = await upload.boundingBox();
    const cameraBox = await camera.boundingBox();
    expect(uploadBox).not.toBeNull();
    expect(cameraBox).not.toBeNull();
    expect(Math.abs(uploadBox!.width - cameraBox!.width)).toBeLessThanOrEqual(
      1
    );
    expect(Math.abs(uploadBox!.height - cameraBox!.height)).toBeLessThanOrEqual(
      1
    );
  });

  test("a photographed page rides the one submit under the one file field", async ({
    page,
  }) => {
    // The absent camera is a STATED precondition, not an assumed one (#2662).
    // On a context with no camera API, #2182's promise is that ONE tap reaches
    // the chooser directly with no dialog in between — which is what the
    // photo-capture-fallback assertion below is then entitled to check.
    await primeCameraFallback(page);
    await page.goto("/data?section=import");

    const fallback = page.getByTestId("photo-capture-file");
    await capturePhotoFile(page, page.getByTestId("medical-upload-camera"), {
      name: `${PREFIX}snap.png`,
      mimeType: "image/png",
      buffer: PNG_1X1,
    });

    // The camera path stays IMAGE-ONLY and keeps `capture`, on an input that is not
    // the picker — the whole reason there are two inputs at all.
    await expect(fallback).toHaveAttribute("accept", "image/*");
    await expect(fallback).toHaveAttribute("capture", "environment");
    await expect(page.getByTestId("medical-upload-input")).not.toHaveAttribute(
      "capture",
      /.*/
    );

    await expect(fallback).toHaveClass(/sr-only/);
    await expect(page.getByTestId("photo-capture-fallback")).toHaveCount(0);
    await expect(page.getByTestId("photo-capture-preview")).toBeVisible();
    // "Use photo" posts NOTHING — it hands the File to the form, which stores it in
    // the real input. The single submit comes later, which is the invariant.
    await hydratedClick(page, page.getByTestId("photo-capture-submit"));

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

  test("the Upload button opens the picker and still takes several files", async ({
    page,
  }) => {
    await page.goto("/data?section=import");

    // The button drives the one real (offscreen) input: proving the picker OPENS is
    // what makes the offscreen input an implementation detail rather than a
    // regression. Multi-file (#1008) survives the redesign.
    const trigger = page.getByTestId("medical-upload-choose-mobile");
    await expect(trigger).toBeVisible();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      hydratedClick(page, trigger),
    ]);
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles([csv(1), csv(2)]);

    const selected = page.getByTestId("medical-upload-selected");
    await expect(selected).toContainText(`${PREFIX}1.csv`);
    await expect(selected).toContainText(`${PREFIX}2.csv`);

    await settledClick(page, page.getByTestId("medical-upload-submit"));
    await expect(page.getByText("2 uploads received")).toBeVisible();
  });
});
