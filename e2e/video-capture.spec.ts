import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_VIDEO,
  E2E_MEMBER_PASSWORD,
  VIDEO_PROFILE,
} from "./fixture-logins";
import { buildMp4Fixture } from "../lib/video/fixture";
import { workerDbPath } from "./worker-env";

// Video capture over the shared video core (#1224 phase 1): the upload-first
// path end to end on the training FORM-CHECK surface — the native file-input
// upload → poster-first grid → open-to-play (the <video> loads only on open) →
// the id-AND-profile-scoped serve route honoring an HTTP Range request (206) →
// the location-metadata privacy warning → delete round trip.
//
// It also pins the #1457 PRESENCE RULES, which split the surface in two: the
// Journal card shows the strip ONLY when clips exist (read/playback + per-clip
// edit/delete, no add), and the activity EDITOR's More-details block is where a
// clip gets attached (always rendered, empty state included, wherever a SAVED
// activity id exists — an upload needs one). So the walk is: no section → open
// editor → add → the card's section appears → delete the last clip → it
// disappears again.
//
// The second test pins the #1524 half of that rule: "a saved id" is NOT "edit
// mode". A create-mode form gains its id the moment autosave inserts the row, and
// the block appears right then — before that (nothing entered, no row) there is
// correctly no block at all, which is what keeps the #1457 deferred-upload
// rejection intact.
//
// The symptom/episode surface renders the SAME shared VideoClipGrid component, so
// this one browser test exercises the identical upload/player/warning contract both
// surfaces use. (Only the training tenant moved its add affordance — the symptom
// strip keeps `showAdd`'s default, so its behavior is untouched.)
//
// Fixture discipline (#868): everything runs as the DEDICATED e2e_video member
// acting on its own seeded profile (one seeded activity) in its own cookie
// context; beforeAll/afterAll clear that profile's activity_videos/symptom_videos
// rows and unlink nothing on disk that another spec reads, so exact-count grid
// assertions are repeat-safe and the shared admin sidebar never changes.
//
// The clip bytes are a LOW-ENTROPY synthetic MP4 header (lib/video/fixture.ts) —
// no real recording, and it carries a synthetic ©xyz location atom so the privacy
// note renders. A synthetic clip won't decode client-side, so the poster is
// (correctly) absent and the grid falls back to its play glyph — exactly the
// posterless path.

const DB_PATH = workerDbPath();

function withDb<T>(fn: (h: Database.Database) => T): T {
  const h = new Database(DB_PATH);
  try {
    return fn(h);
  } finally {
    h.close();
  }
}

function profileId(): number {
  return withDb(
    (h) =>
      (
        h
          .prepare("SELECT id FROM profiles WHERE name = ?")
          .get(VIDEO_PROFILE) as {
          id: number;
        }
      ).id
  );
}

function activityId(): number {
  return withDb(
    (h) =>
      (
        h
          .prepare(
            `SELECT id FROM activities WHERE profile_id = ? AND title = 'Squat session (e2e)'`
          )
          .get(profileId()) as { id: number }
      ).id
  );
}

function cleanup() {
  withDb((h) => {
    const pid = (
      h.prepare("SELECT id FROM profiles WHERE name = ?").get(VIDEO_PROFILE) as
        { id: number } | undefined
    )?.id;
    if (pid == null) return;
    h.prepare(`DELETE FROM activity_videos WHERE profile_id = ?`).run(pid);
    h.prepare(`DELETE FROM symptom_videos WHERE profile_id = ?`).run(pid);
  });
}

test.beforeAll(() => cleanup());
test.afterAll(() => cleanup());

// Drive the editor's "More details" disclosure OPEN (never blind-toggle it): it is a
// pure client toggle inside a freshly mounted editor, so a tap can land before that
// subtree hydrates (#830) and be swallowed, and a second blind click on an
// already-open section would close it again.
async function openMoreDetails(page: Page) {
  const moreDetails = page.locator(
    '[data-testid="activity-more-details"] button[aria-expanded]'
  );
  await expect(moreDetails).toBeVisible();
  await expect(async () => {
    if ((await moreDetails.getAttribute("aria-expanded")) !== "true") {
      await moreDetails.click();
    }
    await expect(moreDetails).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 20_000 }); // topass-ok: drives a client-only disclosure open past the pre-hydration swallow — no server POST to await, so settledClick doesn't apply
}

// Pick an activity in the editor's exercise combobox (the shape-tolerant matcher the
// training specs document: an exact typed match collapses the list to one 'Use "…"').
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("upload → poster grid → open player → Range serve → location warning → delete (form-check surface)", async ({
  browser,
}) => {
  test.slow(); // upload + a route compile on first hit
  const page = await loginAs(browser, {
    username: E2E_LOGIN_VIDEO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const aid = activityId();
    await page.goto("/training");

    // #1457: with no clips, the card carries NO form-check section at all — no
    // heading, no empty text, no button. It used to render on every writable
    // activity regardless of type or content.
    await expect(page.getByTestId(`activity-video-strip-${aid}`)).toHaveCount(
      0
    );

    // The add affordance now lives in the activity editor. Open it from the card
    // title (openEdit → EDIT mode, which is where an activityId exists).
    const card = page
      .getByRole("main")
      .locator('[id^="activity-"]')
      .filter({ hasText: "Squat session (e2e)" })
      .first(); // first-ok: the fixture profile's one seeded activity — order-agnostic
    await card.getByRole("button", { name: "Squat session (e2e)" }).click();

    // Form check sits inside the collapsible More details section. Drive the
    // disclosure to OPEN rather than blind-toggling it: it's a pure client toggle
    // inside a freshly mounted editor, so a tap can land before that subtree
    // hydrates (#830) and be swallowed, and a second blind click on an
    // already-open section would close it again.
    const moreDetails = page.locator(
      '[data-testid="activity-more-details"] button[aria-expanded]'
    );
    await expect(moreDetails).toBeVisible();
    await expect(async () => {
      if ((await moreDetails.getAttribute("aria-expanded")) !== "true") {
        await moreDetails.click();
      }
      await expect(moreDetails).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 20_000 }); // topass-ok: drives a client-only disclosure open past the pre-hydration swallow — no server POST to await, so settledClick doesn't apply
    const formCheck = page.getByTestId("activity-form-check");
    await expect(formCheck).toBeVisible({ timeout: 20_000 });
    const editorStrip = formCheck.getByTestId(`activity-video-strip-${aid}`);
    await expect(editorStrip.getByTestId("video-clip-add")).toBeVisible();

    // Upload a location-tagged synthetic clip via the editor's file input.
    const clip = buildMp4Fixture({
      durationSec: 8,
      creationDate: "2026-05-01",
      location: true,
    });
    await editorStrip.getByTestId("video-clip-input").setInputFiles({
      name: "form-check.mp4",
      mimeType: "video/mp4",
      buffer: clip,
    });

    // The clip lands in the editor's grid (server-sniffed, stored) and its
    // location-metadata privacy note renders.
    await expect(
      editorStrip.locator('[data-testid^="video-clip-item-"]').first() // first-ok: the fixture profile owns exactly one clip after the isolated cleanup
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      editorStrip.locator('[data-testid^="video-clip-location-"]')
    ).toBeVisible();

    // …and now that a clip EXISTS, the card's strip appears — the presence rule's
    // other half. A fresh load also drops the editor.
    await page.goto("/training");
    const strip = page.getByTestId(`activity-video-strip-${aid}`);
    await expect(strip).toBeVisible();
    // Read surface: playback and per-clip controls, but no add affordance here.
    await expect(strip.getByTestId("video-clip-add")).toHaveCount(0);
    const clipTile = strip.locator('[data-testid^="video-clip-item-"]').first(); // first-ok: the fixture profile owns exactly one clip after the isolated cleanup
    await expect(clipTile).toBeVisible({ timeout: 20_000 });
    await expect(
      strip.locator('[data-testid^="video-clip-location-"]')
    ).toBeVisible();

    // The stored row exists; read its id for the serve-route + open checks.
    const clipId = withDb(
      (h) =>
        (
          h
            .prepare(
              `SELECT id FROM activity_videos WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
            )
            .get(profileId()) as { id: number }
        ).id
    );

    // Open the clip → the <video> element mounts (loads only on open).
    await strip.getByTestId(`video-clip-open-${clipId}`).click();
    await expect(
      strip.getByTestId(`video-clip-player-${clipId}`)
    ).toBeVisible();

    // Serve route: id+profile scoped, honors a Range request (206) and advertises
    // byte ranges; a bogus id is a JSON 404.
    const full = await page.request.get(`/api/activity-video/${clipId}`);
    expect(full.status()).toBe(200);
    expect(full.headers()["accept-ranges"]).toBe("bytes");
    const ranged = await page.request.get(`/api/activity-video/${clipId}`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-9\//);
    const bogus = await page.request.get(`/api/activity-video/99999999`);
    expect(bogus.status()).toBe(404);
    expect(await bogus.json()).toEqual({ ok: false, error: "not found" });

    // Delete → the card's per-clip control still works (only ADD moved away), and
    // with the last clip gone the whole section disappears again (#1457).
    await settledClick(page, strip.getByTestId(`video-clip-delete-${clipId}`));
    await expect(page.getByTestId(`activity-video-strip-${aid}`)).toHaveCount(
      0,
      { timeout: 20_000 }
    );
  } finally {
    await page.context().close();
  }
});

test("Form check appears mid-CREATE, as soon as autosave has made the row (#1524)", async ({
  browser,
}) => {
  test.slow(); // upload + a route compile on first hit
  const page = await loginAs(browser, {
    username: E2E_LOGIN_VIDEO,
    password: E2E_MEMBER_PASSWORD,
  });
  let createdId: number | null = null;
  try {
    // #1524: the block used to gate on `editData`, which is null for a create-mode
    // form's WHOLE LIFE — so while first-time logging (the moment you'd want to
    // attach a form-check clip) it never appeared, and the only way in was to save,
    // close and reopen the activity.
    await page.goto("/training");
    await page
      .getByRole("main")
      .getByRole("button", { name: "New activity" })
      .click();
    await openMoreDetails(page);

    // Nothing entered yet → no saved row → correctly NO block (the #1457 data
    // constraint is unchanged; deferred client-side upload stays rejected).
    await expect(page.getByTestId("activity-form-check")).toHaveCount(0);

    // Complete a set: autosave (700ms debounce) INSERTs the activity, and the
    // block appears on that null→created transition without a reopen.
    await pickActivity(page, "Barbell Bench Press");
    await page.getByTestId("set1-weight").fill("20");
    await page.getByTestId("set1-reps-stepper").locator("input").fill("5");
    const formCheck = page.getByTestId("activity-form-check");
    await expect(formCheck).toBeVisible({ timeout: 20_000 });

    // It targets the row autosave just created — read the id off the strip the
    // block rendered, which is also what the upload will attach to.
    const strip = formCheck.locator('[data-testid^="activity-video-strip-"]');
    const testid = await strip.getAttribute("data-testid");
    createdId = Number(testid!.replace("activity-video-strip-", ""));
    expect(createdId).toBeGreaterThan(0);
    expect(createdId).not.toBe(activityId()); // the seeded activity, not this one

    // An upload from the create-mode block lands on the NEW activity.
    await strip.getByTestId("video-clip-input").setInputFiles({
      name: "create-mode.mp4",
      mimeType: "video/mp4",
      buffer: buildMp4Fixture({ durationSec: 5 }),
    });
    await expect(
      strip.locator('[data-testid^="video-clip-item-"]')
    ).toHaveCount(1);
    expect(
      withDb(
        (h) =>
          (
            h
              .prepare(
                `SELECT COUNT(*) AS n FROM activity_videos WHERE profile_id = ? AND activity_id = ?`
              )
              .get(profileId(), createdId) as { n: number }
          ).n
      )
    ).toBe(1);
  } finally {
    // Spec-owned fixture: drop the activity this test created (and its children),
    // so the profile is back to its one seeded activity for the test above.
    if (createdId != null) {
      withDb((h) => {
        h.prepare(`DELETE FROM activity_videos WHERE activity_id = ?`).run(
          createdId
        );
        h.prepare(`DELETE FROM exercise_sets WHERE activity_id = ?`).run(
          createdId
        );
        h.prepare(`DELETE FROM activities WHERE id = ?`).run(createdId);
      });
    }
    await page.context().close();
  }
});
