import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_PHOTOS,
  E2E_MEMBER_PASSWORD,
  PROGRESS_PHOTOS_PROFILE,
} from "./fixture-logins";

// Progress photos over the shared photo core (#1119): the native-capture
// FALLBACK path end to end (CI has no camera, so getUserMedia is denied and
// PhotoCapture drops to its file input — exactly the fallback contract), the
// pose-tagged upload → gallery grid → lightbox → delete round trip, the
// two-date compare timeline with the onion-skin overlay toggle, the serve
// route's session/id scoping, and the data-gated nav entry flipping on for a
// profile once it has a photo.
//
// Fixture discipline (#868): everything runs as the DEDICATED e2e_photos member
// acting on its own profile (seeded photo-less by e2e/seed-events.ts) in its own
// cookie context; beforeAll/afterAll clear that profile's progress_photos rows,
// so exact-count grid assertions are repeat-safe and the shared admin sidebar
// (whose top-level order nav-consolidation.spec.ts pins verbatim) never gains
// the data-gated entry.

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

function fixtureProfileId(): number {
  const handle = new Database(DB_PATH);
  try {
    return (
      handle
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(PROGRESS_PHOTOS_PROFILE) as { id: number }
    ).id;
  } finally {
    handle.close();
  }
}

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `DELETE FROM progress_photos
          WHERE profile_id IN (SELECT id FROM profiles WHERE name = ?)`
      )
      .run(PROGRESS_PHOTOS_PROFILE);
  } finally {
    handle.close();
  }
}

// Real decodable JPEGs (sharp-generated, synthetic) — the client re-encodes
// through a canvas and the server pipeline re-decodes, so a magic-bytes-only
// stub isn't enough here. Distinct colors → distinct content hashes (the
// per-profile dedup would otherwise collapse the second upload).
async function jpeg(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({
    create: { width: 600, height: 800, channels: 3, background: rgb },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

test.beforeAll(() => cleanup());
test.afterAll(() => cleanup());

// Drive the capture flow's fallback path: open → pick file → confirm step →
// set date (deterministic ordering for the compare selects) → submit (the
// Server-Action POST settledClick awaits).
async function addPhoto(
  page: Page,
  bytes: Buffer,
  opts: { date: string; caption?: string }
): Promise<void> {
  // Re-click until the capture modal opens — a pre-hydration click on the
  // trigger is swallowed (#500-class), no single expect can both re-click and
  // await the modal, and opening is idempotent (toPass: the commented last
  // resort, mirroring nav-consolidation's drawer pattern).
  const fileInput = page.getByTestId("photo-capture-file");
  await expect(async () => {
    if (!(await fileInput.isVisible())) {
      await page.getByTestId("photo-capture-open").click();
    }
    await expect(fileInput).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: pre-hydration click swallow on the modal trigger — re-click + await can't be one retrying expect (the drawer precedent in nav-consolidation.spec)
  await fileInput.setInputFiles({
    name: "capture.jpg",
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await expect(page.getByTestId("photo-capture-preview")).toBeVisible();
  await page.locator("#progress-date").fill(opts.date);
  if (opts.caption)
    await page.getByTestId("progress-caption-input").fill(opts.caption);
  await settledClick(page, page.getByTestId("photo-capture-submit"));
  await expect(page.getByTestId("photo-capture-preview")).toBeHidden();
}

test("upload → grid → lightbox → compare → delete round trip (fallback capture path)", async ({
  browser,
}) => {
  test.slow(); // two uploads + a route compile on first hit
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Photo-less profile: the data-gated nav entry is hidden, the page still
    // renders by URL (#1042 posture) with its empty state.
    await page.goto("/");
    await expect(
      page.locator("aside").getByRole("link", { name: "Progress photos" })
    ).toHaveCount(0);
    await page.goto("/progress");
    await expect(
      page.getByRole("heading", { name: "Progress photos" })
    ).toBeVisible();
    await expect(page.getByTestId("photo-gallery-empty")).toBeVisible();

    // First photo (front, older date).
    await addPhoto(page, await jpeg({ r: 190, g: 40, b: 40 }), {
      date: "2026-07-01",
      caption: "E2EProg baseline",
    });
    await expect(
      page.locator('[data-testid^="photo-gallery-item-"]')
    ).toHaveCount(1);

    // Second photo, same pose, later date → a comparable series of two.
    await addPhoto(page, await jpeg({ r: 40, g: 40, b: 190 }), {
      date: "2026-07-10",
    });
    const items = page.locator('[data-testid^="photo-gallery-item-"]');
    await expect(items).toHaveCount(2);

    // The nav entry lit up for THIS profile now that it has photos.
    await expect(
      page.locator("aside").getByRole("link", { name: "Progress photos" })
    ).toBeVisible();

    // Pose sub-filter: everything is front; side is empty.
    await page.getByTestId("photo-gallery-series-side").click();
    await expect(page.getByTestId("photo-gallery-empty")).toBeVisible();
    await page.getByTestId("photo-gallery-series-front").click();
    await expect(items).toHaveCount(2);

    // Lightbox: newest-first grid → item 0 is the 07-10 photo; the served
    // ORIGINAL loads (id+profile-scoped route), next pages to the older one.
    await items.nth(0).click();
    await expect(page.getByTestId("photo-lightbox")).toBeVisible();
    await expect(page.getByTestId("photo-lightbox-image")).toBeVisible();
    await expect(page.getByTestId("photo-lightbox")).toContainText(
      "2026-07-10"
    );
    await page.getByTestId("photo-lightbox-next").click();
    await expect(page.getByTestId("photo-lightbox")).toContainText(
      "2026-07-01"
    );
    await expect(page.getByTestId("photo-lightbox")).toContainText(
      "E2EProg baseline"
    );
    await page.getByTestId("photo-lightbox-close").click();

    // Serve-route scoping from the browser session: the real photo id serves
    // 200 JPEG (original + thumb); a bogus id is a JSON 404.
    const db = new Database(DB_PATH);
    let photoIds: number[];
    try {
      photoIds = (
        db
          .prepare(
            `SELECT id FROM progress_photos WHERE profile_id = ? ORDER BY id`
          )
          .all(fixtureProfileId()) as { id: number }[]
      ).map((r) => r.id);
    } finally {
      db.close();
    }
    expect(photoIds).toHaveLength(2);
    const served = await page.request.get(`/api/progress-photo/${photoIds[0]}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/jpeg");
    const thumb = await page.request.get(
      `/api/progress-photo/${photoIds[0]}?thumb=1`
    );
    expect(thumb.status()).toBe(200);
    const bogus = await page.request.get(`/api/progress-photo/99999999`);
    expect(bogus.status()).toBe(404);
    expect(await bogus.json()).toEqual({ ok: false, error: "not found" });

    // Compare: the two-date timeline defaults to first-vs-latest side by side;
    // the onion-skin overlay toggle swaps in the blended view.
    await page.getByTestId("progress-view-compare").click();
    await expect(page.getByTestId("photo-timeline")).toBeVisible();
    await expect(page.getByTestId("photo-timeline-side")).toBeVisible();
    await expect(page.getByTestId("photo-timeline-a")).toHaveValue("0");
    await expect(page.getByTestId("photo-timeline-b")).toHaveValue("1");
    await page.getByTestId("photo-timeline-overlay-toggle").check();
    await expect(page.getByTestId("photo-timeline-overlay")).toBeVisible();
    await expect(page.getByTestId("photo-timeline-side")).toHaveCount(0);

    // Delete from the lightbox (confirm dialog accepted) → one photo remains.
    await page.getByTestId("progress-view-grid").click();
    await items.nth(0).click();
    page.once("dialog", (d) => void d.accept());
    await settledClick(page, page.getByTestId("photo-lightbox-delete"));
    await expect(items).toHaveCount(1);
  } finally {
    await page.context().close();
  }
});
