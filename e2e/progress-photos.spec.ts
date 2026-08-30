import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { loginAs } from "./nav";
import {
  capturePhotoFile,
  dismissToast,
  expectNoClippedContent,
  expectPhoneTapTargets,
  followLink,
  primeCameraFallback,
  settledClick,
  settledBoxes,
  settledSelect,
} from "./helpers";
import {
  E2E_LOGIN_PHOTOS,
  E2E_MEMBER_PASSWORD,
  PROGRESS_PHOTOS_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

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

const DB_PATH = workerDbPath();

async function expectReadableOnBlack(control: Locator, name: string) {
  const ratio = await control.evaluate((element) => {
    const luminance = (color: string) => {
      const channels = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (
      (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05)
    );
  });
  expect(ratio, `${name} computed contrast`).toBeGreaterThanOrEqual(4.5);
}

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
  // One real tap must synchronously open the native chooser, with no
  // intermediate fallback dialog (#2182) — which holds because the caller
  // staged the no-camera-API precondition before its goto (#2662).
  const fileInput = page.getByTestId("photo-capture-file");
  await capturePhotoFile(page, page.getByTestId("photo-capture-open"), {
    name: "capture.jpg",
    mimeType: "image/jpeg",
    buffer: bytes,
  });
  await expect(fileInput).toHaveClass(/sr-only/);
  await expect(page.getByTestId("photo-capture-fallback")).toHaveCount(0);
  await expect(page.getByTestId("photo-capture-preview")).toBeVisible();
  await page.locator("#progress-date").fill(opts.date);
  if (opts.caption)
    await page.getByTestId("progress-caption-input").fill(opts.caption);
  await settledClick(page, page.getByTestId("photo-capture-submit"));
  await expect(page.getByTestId("photo-capture-preview")).toBeHidden();
}

// THE IN-DOMAIN DOOR (#3284). The #1119 nav gate is data-presence and correct, which
// left the command palette as the only always-visible entry point — invisible to
// anyone who does not already know to search for it. Trends → Overview is where the
// body census is read, which is the context physique photos belong to.
//
// Runs FIRST in this file and clears the fixture itself, so the zero-state label is
// a real observation under --repeat-each rather than a leftover from the round trip
// below (which deliberately leaves one photo behind).
test("Trends → Body carries the always-visible first-capture door, at phone and desktop width (#3284)", async ({
  browser,
}) => {
  cleanup();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const door = page.getByTestId("body-progress-photos-link");
    // BOTH widths, because a door that overflows its row at 390 is not a door. 1280
    // is the desktop project's own viewport; 390 is the phone, and the head row it
    // shares with the Timeline link is where a two-link row can run out of width.
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/trends");
      await expect(door).toBeVisible();
      // Zero photos + a write grant: the entry IS the invitation (#3077).
      await expect(door).toHaveText("Add a progress photo");
      await expectNoClippedContent(page);
    }
    await followLink(page, door, /\/progress$/);
    await expect(page.getByTestId("photo-gallery-empty")).toBeVisible();
    // Two taps from the census to the capture flow, with no palette involved.
    await page.getByTestId("photo-capture-open").click();
    await expect(page.getByTestId("photo-capture-file")).toHaveCount(1);
  } finally {
    await page.context().close();
  }
});

test("upload → grid → lightbox → compare → delete round trip (fallback capture path)", async ({
  browser,
}) => {
  test.slow(); // two uploads + a route compile on first hit
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await primeCameraFallback(page);
    // Photo-less profile: the data-gated nav entry is hidden, the page still
    // renders by URL (#1042 posture) with its empty state.
    //
    // EXPAND THE GROUP FIRST (#3079). Progress photos is a child of "Plan &
    // review", which is COLLAPSED on "/" — so this count would read 0 whether the
    // relevance gate worked or not, and the case would go on passing against the
    // very regression it exists to catch. Expanding, and proving the expansion with
    // an ungated sibling, makes the absence a real observation again. Same shape as
    // the #1522 medicine-cabinet case in e2e/nav-consolidation.spec.ts.
    await page.goto("/");
    // `aside nav`, not `aside`: FrequentPages (#1416) renders its shortcuts as
    // plain links in the same aside, so an aside-wide role query can collide with
    // a shortcut carrying the same label.
    const sidebarNav = page.locator("aside nav");
    await sidebarNav.getByRole("button", { name: "Plan & review" }).click();
    await expect(
      sidebarNav.getByRole("link", { name: "History" })
    ).toBeVisible();
    await expect(
      sidebarNav.getByRole("link", { name: "Progress photos" })
    ).toHaveCount(0);
    // Reach the page through the #3284 door rather than by URL, so this case also
    // carries the acceptance criterion that a first capture made THROUGH the Trends
    // door flips the nav relevance bit asserted below.
    await page.goto("/trends");
    await followLink(
      page,
      page.getByTestId("body-progress-photos-link"),
      /\/progress$/
    );
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

    // The nav entry lit up for THIS profile now that it has photos, and the door
    // drops its invitation for the browse label over the same destination.
    await expect(
      page.locator("aside").getByRole("link", { name: "Progress photos" })
    ).toBeVisible();
    await page.goto("/trends");
    await expect(page.getByTestId("body-progress-photos-link")).toHaveText(
      "Progress photos"
    );
    await page.goBack();

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

    await page.setViewportSize({ width: 390, height: 844 });
    const opacity = page.getByRole("slider", { name: "Blend" });
    await expectPhoneTapTargets(page, "photo opacity range", [opacity]);
    const [toggleBox, opacityBox] = await settledBoxes([
      page.getByText("Onion-skin overlay", { exact: true }),
      opacity,
    ]);
    expect(
      Math.min(toggleBox.x + toggleBox.width, opacityBox.x + opacityBox.width) -
        Math.max(toggleBox.x, opacityBox.x) >
        0 &&
        Math.min(
          toggleBox.y + toggleBox.height,
          opacityBox.y + opacityBox.height
        ) -
          Math.max(toggleBox.y, opacityBox.y) >
          0,
      "Blend target overlaps its adjacent onion-skin target"
    ).toBe(false);
    await opacity.focus();
    await expect(opacity).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(opacity).toHaveValue("51");

    // Delete from the lightbox through the app confirmation → one photo remains.
    await page.getByTestId("progress-view-grid").click();
    await items.nth(0).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectPhoneTapTargets(
      page,
      "photo lightbox actions",
      [
        page.getByTestId("photo-lightbox-compare"),
        page.getByTestId("photo-lightbox-edit"),
        page.getByTestId("photo-lightbox-delete"),
      ],
      { disjoint: true }
    );
    const actions = [
      page.getByTestId("photo-lightbox-compare"),
      page.getByTestId("photo-lightbox-edit"),
      page.getByTestId("photo-lightbox-delete"),
    ];
    for (const dark of [false, true]) {
      await page.evaluate(
        (enabled) => document.documentElement.classList.toggle("dark", enabled),
        dark
      );
      for (const [index, action] of actions.entries())
        await expectReadableOnBlack(action, `photo action ${index}`);
    }

    const deleteAction = page.getByTestId("photo-lightbox-delete");
    await deleteAction.click();
    const confirm = page.getByTestId("confirm-dialog");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(deleteAction).toBeFocused();

    await deleteAction.click();
    await settledClick(
      page,
      confirm.getByRole("button", { name: "Delete photo" })
    );
    await expect(page.getByTestId("photo-lightbox")).toBeHidden();
    await dismissToast(page, "Photo deleted.");
    await expect(items).toHaveCount(1);
    await items.click();
    await expect(page.getByTestId("photo-lightbox")).toContainText(
      "2026-07-01"
    );
    await page.getByTestId("photo-lightbox-close").click();
  } finally {
    await page.context().close();
  }
});

test("crop zoom keeps native range behavior and fixed phone geometry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/health");
  await page.locator('input[type="file"]').setInputFiles({
    name: "crop.jpg",
    mimeType: "image/jpeg",
    buffer: await jpeg({ r: 90, g: 140, b: 180 }),
  });
  const zoom = page.getByRole("slider", { name: "Zoom" });
  await expect(zoom).toBeEnabled();
  await expectPhoneTapTargets(
    page,
    "crop zoom range",
    [zoom, page.getByRole("button", { name: "Save photo" })],
    { disjoint: true }
  );
  await zoom.focus();
  await expect(zoom).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(zoom).toHaveValue("1.01");
  await page.setViewportSize({ width: 1280, height: 844 });
  expect((await zoom.boundingBox())!.height).toBeLessThan(44);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("a denied auto-open explains recovery, while missing hardware stays picker-only", async ({
  browser,
}) => {
  const denied = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await denied.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(
              new DOMException("Camera permission denied", "NotAllowedError")
            ),
        },
      });
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: {
          query: async () => ({ state: "denied", onchange: null }),
        },
      });
    });
    await denied.goto("/progress?new=1");
    await expect(
      denied.getByTestId("photo-capture-blocked-guidance")
    ).toBeVisible();
    await expect(
      denied.getByTestId("photo-capture-camera-retry")
    ).toBeVisible();
    await expect(denied.getByTestId("photo-capture-picker-open")).toBeVisible();
  } finally {
    await denied.context().close();
  }

  const missing = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await missing.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(new DOMException("No camera", "NotFoundError")),
        },
      });
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: "prompt", onchange: null }) },
      });
    });
    await missing.goto("/progress");
    await missing.getByTestId("photo-capture-open").click();
    await expect(missing.getByTestId("photo-capture-fallback")).toBeVisible();
    await expect(
      missing.getByTestId("photo-capture-blocked-guidance")
    ).toHaveCount(0);
    await expect(missing.getByTestId("photo-capture-camera-retry")).toHaveCount(
      0
    );
    await expect(
      missing.getByTestId("photo-capture-picker-open")
    ).toBeVisible();
  } finally {
    await missing.context().close();
  }
});

// Metadata correction (#1934): the row is editable, the BYTES are not.
//
// Progress photos were delete-only, so a side photo tagged `front` could only be
// repaired by deleting and re-uploading — throwing away the original file, its
// content_hash, and its place in the series. This drives the lightbox "Edit details"
// action and asserts the thing a pose retag is FOR: the photo moves between comparison
// series, and its stored artifacts do not change.
test("retagging a photo's pose moves it between comparison series, leaving the file untouched (#1934)", async ({
  browser,
}) => {
  test.slow(); // two uploads + a route compile on first hit
  cleanup();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PHOTOS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await primeCameraFallback(page);
    await page.goto("/progress");
    await expect(
      page.getByRole("heading", { name: "Progress photos" })
    ).toBeVisible();

    // Two FRONT photos → a comparable front series of two, side empty.
    await addPhoto(page, await jpeg({ r: 30, g: 160, b: 90 }), {
      date: "2026-06-01",
    });
    await addPhoto(page, await jpeg({ r: 160, g: 30, b: 90 }), {
      date: "2026-06-15",
    });
    const items = page.locator('[data-testid^="photo-gallery-item-"]');
    await expect(items).toHaveCount(2);

    // The artifacts BEFORE the correction, straight from the row.
    const handle = new Database(DB_PATH);
    let before: {
      id: number;
      pose: string;
      stored_path: string;
      content_hash: string;
    }[];
    try {
      before = handle
        .prepare(
          `SELECT id, pose, stored_path, content_hash FROM progress_photos
            WHERE profile_id = ? ORDER BY date`
        )
        .all(fixtureProfileId()) as typeof before;
    } finally {
      handle.close();
    }
    expect(before.map((r) => r.pose)).toEqual(["front", "front"]);

    // Compare: the FRONT series has both photos to choose between.
    await page.getByTestId("progress-view-compare").click();
    await page.getByTestId("progress-compare-pose-front").click();
    await expect(page.getByTestId("photo-timeline")).toBeVisible();
    await expect(
      page.getByTestId("photo-timeline-a").locator("option")
    ).toHaveCount(2);

    // Retag the NEWEST photo (grid item 0) as Side, through the lightbox row action.
    await page.getByTestId("progress-view-grid").click();
    await page.getByTestId("photo-gallery-series-front").click();
    await items.nth(0).click();
    await expect(page.getByTestId("photo-lightbox")).toBeVisible();
    await page.getByTestId("photo-lightbox-edit").click();
    await expect(page.getByTestId("progress-edit-modal")).toBeVisible();
    await settledSelect(page, page.getByTestId("progress-edit-pose"), "side");
    await settledClick(page, page.getByTestId("progress-edit-save"));
    await expect(page.getByTestId("progress-edit-modal")).toBeHidden();

    // THE PIN: it MOVED series. Front is down to one, Side holds the other — the
    // compare timeline reads pose membership, so the retag re-files it.
    await page.getByTestId("progress-view-compare").click();
    await page.getByTestId("progress-compare-pose-front").click();
    // Fewer than two Front photos left → the timeline collapses to its empty hint.
    await expect(page.getByTestId("photo-timeline-a")).toHaveCount(0);
    await expect(
      page.getByText("Add at least two Front photos to compare over time.")
    ).toBeVisible();
    await page.getByTestId("progress-compare-pose-side").click();
    await expect(
      page.getByText("Add at least two Side photos to compare over time.")
    ).toBeVisible();

    // The row changed; the stored artifacts did not.
    const after = new Database(DB_PATH);
    try {
      const rows = after
        .prepare(
          `SELECT id, pose, stored_path, content_hash FROM progress_photos
            WHERE profile_id = ? ORDER BY date`
        )
        .all(fixtureProfileId()) as typeof before;
      expect(rows.map((r) => r.pose)).toEqual(["front", "side"]);
      expect(rows.map((r) => r.stored_path)).toEqual(
        before.map((r) => r.stored_path)
      );
      expect(rows.map((r) => r.content_hash)).toEqual(
        before.map((r) => r.content_hash)
      );
    } finally {
      after.close();
    }

    // The bytes still serve: the correction never touched the file store.
    const served = await page.request.get(
      `/api/progress-photo/${before[1].id}`
    );
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/jpeg");
  } finally {
    await page.context().close();
  }
});
