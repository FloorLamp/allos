import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
import {
  E2E_LOGIN_HHHIST,
  E2E_LOGIN_SICK_VIDEO,
  E2E_MEMBER_PASSWORD,
  HH_HISTORY_CHILD_PROFILE,
  SICK_VIDEO_PROFILE,
} from "./fixture-logins";
import { buildM4aFixture, buildMp4Fixture } from "../lib/video/fixture";
import { workerDbPath } from "./worker-env";

// The episode page's SYMPTOM VIDEO strip (#1598 — components/illness/SymptomVideoStrip
// on /medical/episodes/[id]). It is the OTHER shipped half of the #1224 video core, and
// until now no browser spec rendered it: video-capture.spec drives only the training
// form-check tenant, so the symptom strip's own mount — its empty copy, its add
// affordance, its date labels, its serve route — was proven nowhere.
//
// The two tenants share VideoClipGrid, so this spec deliberately does NOT re-litigate
// the grid's generic mechanics. What is symptom-SPECIFIC, and what this covers, is:
//   • the strip renders on the episode cockpit at all, with its own empty copy and the
//     `showAdd` default the training tenant overrode (#1457 moved only training's add);
//   • a clip is dated to the COCKPIT'S LOG DAY (`uploadDate`) and therefore falls inside
//     the [episode.start, today] window the page gathers over — a clip stored outside it
//     is invisible, which is exactly what a blind spot hides;
//   • its OWN serve route, /api/symptom-video/[id]: 200 + Range 206, the posterless
//     `?poster=1` 404 that drives the tile's placeholder fallback, and a bogus-id 404;
//   • the caption round trip and delete-back-to-empty through the episode actions;
//   • the CAREGIVER case (#1696): the page resolves an episode across the viewer's
//     ACCESSIBLE profiles (#879), so the serve route must too — a clip on a household
//     member's episode plays while the caregiver's ACTIVE profile is someone else, and
//     still 404s (identically to a missing id) for a login with no grant on the owner.
//
// Fixture discipline (#868): a DEDICATED sick-solo member (e2e_sick_video, seeded by
// e2e/seed-events.ts) acting on its own OPEN episode, in its own cookie context. The
// fixture is seeded CLIPLESS and every test deletes what it attached, so the exact-count
// and back-to-empty assertions are repeat-safe and no shared profile is touched. The
// caregiver case REUSES the existing household-history caregiver (e2e_hhhist, granted a
// well parent + a currently-sick child) rather than minting another fixture login, and
// removes the one clip it attaches to the child.
//
// The clip bytes are LOW-ENTROPY synthetic container headers (lib/video/fixture.ts) — no
// real recording. They carry no decodable frames, so the client poster extraction
// correctly yields nothing and the posterless path is the one under test.

const DB_PATH = workerDbPath();

function withDb<T>(fn: (h: Database.Database) => T): T {
  const h = new Database(DB_PATH);
  try {
    return fn(h);
  } finally {
    h.close();
  }
}

function profileId(name = SICK_VIDEO_PROFILE): number {
  return withDb(
    (h) =>
      (
        h.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
          id: number;
        }
      ).id
  );
}

interface ClipRow {
  id: number;
  date: string;
  kind: string;
  poster_path: string | null;
}

// The fixture profile's newest clip row — the id the DOM testids and the serve route
// are both keyed on. The profile owns at most one clip at a time here.
function latestClip(pid = profileId()): ClipRow {
  return withDb(
    (h) =>
      h
        .prepare(
          `SELECT id, date, kind, poster_path FROM symptom_videos
            WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(pid) as ClipRow
  );
}

function clearClips(profileName: string) {
  withDb((h) => {
    const pid = (
      h.prepare("SELECT id FROM profiles WHERE name = ?").get(profileName) as
        { id: number } | undefined
    )?.id;
    if (pid == null) return;
    h.prepare("DELETE FROM symptom_videos WHERE profile_id = ?").run(pid);
  });
}

// Both fixtures this spec attaches clips to — its own sick-solo profile and the
// household-history CHILD the caregiver case reads across (#1696).
function cleanup() {
  clearClips(SICK_VIDEO_PROFILE);
  clearClips(HH_HISTORY_CHILD_PROFILE);
}

test.beforeAll(() => cleanup());
test.afterAll(() => cleanup());

// Reach this fixture's OWN open episode through the care trail (it owns exactly one).
async function openEpisode(page: Page) {
  await page.goto("/medical/episodes");
  const row = page
    .getByTestId("episode-index-row")
    .filter({ hasText: /ongoing/i })
    .first(); // first-ok: spec-owned fixture with a single ongoing episode — order-agnostic
  await followLink(page, row, /\/medical\/episodes\/\d+/);
  const strip = page.getByTestId("symptom-video-strip");
  await expect(strip).toBeVisible();
  return strip;
}

test("the episode strip renders empty, takes a dated clip, serves it by Range, and deletes back to empty (#1598)", async ({
  browser,
}) => {
  test.slow(); // an upload plus first-hit route compiles
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SICK_VIDEO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const strip = await openEpisode(page);

    // The blind spot itself: with no clips the strip still renders, carrying the
    // symptom-specific empty copy and — unlike the training tenant, whose add moved
    // into the activity editor (#1457) — its own add affordance.
    await expect(
      strip.getByText(/No clips yet\. Add one to capture a symptom in motion/)
    ).toBeVisible();
    await expect(strip.getByTestId("video-clip-add")).toBeVisible();
    await expect(
      strip.locator('[data-testid^="video-clip-item-"]')
    ).toHaveCount(0);

    // Attach a location-tagged synthetic clip with a caption. The strip posts the
    // cockpit's log day as the upload date.
    await strip.getByLabel("Caption (optional)").fill("Barking cough at night");
    await strip.getByTestId("video-clip-input").setInputFiles({
      name: "cough.mp4",
      mimeType: "video/mp4",
      buffer: buildMp4Fixture({ durationSec: 12, location: true }),
    });
    await expect(page.getByText("Clip attached.")).toBeVisible({
      timeout: 20_000,
    }); // named ceiling: the upload rides a Server Action + router.refresh()

    const clip = latestClip();
    expect(clip.kind).toBe("video");
    const tile = strip.getByTestId(`video-clip-item-${clip.id}`);
    await expect(tile).toBeVisible({ timeout: 20_000 }); // named ceiling: the tile appears with the revalidated RSC

    // THE symptom-specific payoff: the clip is dated to the cockpit's log day, which is
    // what puts it inside the [episode.start, today] window the page gathers over — the
    // tile labels itself with that date, and the caption rides along.
    await expect(tile).toContainText(clip.date);
    await expect(tile).toContainText("Barking cough at night");
    await expect(
      strip.getByTestId(`video-clip-location-${clip.id}`)
    ).toBeVisible();

    // Posterless fallback: a synthetic container has no decodable frame, so no poster
    // was stored and `?poster=1` is a clean JSON 404 — which is what makes the tile's
    // <img> fail and hide itself, leaving the play glyph as the placeholder.
    expect(clip.poster_path).toBeNull();
    const posterResp = await page.request.get(
      `/api/symptom-video/${clip.id}?poster=1`
    );
    expect(posterResp.status()).toBe(404);
    expect(await posterResp.json()).toEqual({ ok: false, error: "no poster" });
    await expect(tile.locator("img")).toHaveCSS("visibility", "hidden");

    // Open to play: the <video> mounts only here (the grid is poster-first).
    await tile.getByTestId(`video-clip-open-${clip.id}`).click();
    const player = tile.getByTestId(`video-clip-player-${clip.id}`);
    await expect(player).toBeVisible();
    expect(await player.evaluate((el: Element) => el.tagName)).toBe("VIDEO");

    // The symptom serve route — its own handler, not the activity one: session-gated,
    // id+profile scoped, Range-capable, and a JSON 404 for an id this profile can't see.
    const full = await page.request.get(`/api/symptom-video/${clip.id}`);
    expect(full.status()).toBe(200);
    expect(full.headers()["accept-ranges"]).toBe("bytes");
    const ranged = await page.request.get(`/api/symptom-video/${clip.id}`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(ranged.status()).toBe(206);
    expect(ranged.headers()["content-range"]).toMatch(/^bytes 0-9\//);
    const bogus = await page.request.get(`/api/symptom-video/99999999`);
    expect(bogus.status()).toBe(404);
    expect(await bogus.json()).toEqual({ ok: false, error: "not found" });

    // Caption round trip through the episode action (the strip's third write path).
    await tile.getByTestId(`video-clip-edit-${clip.id}`).click();
    const captionInput = tile.getByTestId(
      `video-clip-caption-input-${clip.id}`
    );
    await expect(captionInput).toBeVisible();
    await captionInput.fill("Cough, worse lying down");
    await settledClick(page, tile.getByRole("button", { name: "Save" }));
    await expect(page.getByText("Caption updated.")).toBeVisible({
      timeout: 20_000,
    }); // named ceiling: the caption write rides a Server Action + router.refresh()
    await expect(tile).toContainText("Cough, worse lying down", {
      timeout: 20_000,
    }); // named ceiling: the revalidated RSC replaces the figcaption

    // Delete the last clip → the strip falls back to its empty copy (it is always
    // rendered on a writable episode, so nothing disappears — only the grid empties).
    await settledClick(page, tile.getByTestId(`video-clip-delete-${clip.id}`));
    await expect(
      strip.locator('[data-testid^="video-clip-item-"]')
    ).toHaveCount(0, { timeout: 20_000 }); // named ceiling: the delete rides a Server Action + router.refresh()
    await expect(
      strip.getByText(/No clips yet\. Add one to capture a symptom in motion/)
    ).toBeVisible();
  } finally {
    cleanup();
    await page.context().close();
  }
});

test("an audio clip lands on the same strip as a mic tile and plays through <audio> (#1598)", async ({
  browser,
}) => {
  test.slow(); // an upload plus first-hit route compiles
  const page = await loginAs(browser, {
    username: E2E_LOGIN_SICK_VIDEO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    const strip = await openEpisode(page);

    // The strip's own copy advertises a "cough/breathing sound" — an AUDIO capture, which
    // its file input accepts (`video/*,audio/*`). An audio clip has no frame to poster, so
    // its tile is the mic glyph rather than an image, and it opens into <audio>.
    await strip.getByTestId("video-clip-input").setInputFiles({
      name: "wheeze.m4a",
      mimeType: "audio/mp4",
      buffer: buildM4aFixture({ durationSec: 9 }),
    });
    await expect(page.getByText("Clip attached.")).toBeVisible({
      timeout: 20_000,
    }); // named ceiling: the upload rides a Server Action + router.refresh()

    const clip = latestClip();
    expect(clip.kind).toBe("audio");
    const tile = strip.getByTestId(`video-clip-item-${clip.id}`);
    await expect(tile).toBeVisible({ timeout: 20_000 }); // named ceiling: the tile appears with the revalidated RSC
    await expect(tile.locator("img")).toHaveCount(0);

    await tile.getByTestId(`video-clip-open-${clip.id}`).click();
    const player = tile.getByTestId(`video-clip-player-${clip.id}`);
    await expect(player).toBeVisible();
    expect(await player.evaluate((el: Element) => el.tagName)).toBe("AUDIO");

    const served = await page.request.get(`/api/symptom-video/${clip.id}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toMatch(/^audio\//);

    // Own what this test attached, so the neighbour above always starts from empty.
    await settledClick(page, tile.getByTestId(`video-clip-delete-${clip.id}`));
    await expect(
      strip.locator('[data-testid^="video-clip-item-"]')
    ).toHaveCount(0, { timeout: 20_000 }); // named ceiling: the delete rides a Server Action + router.refresh()
  } finally {
    cleanup();
    await page.context().close();
  }
});

test("a caregiver reading a household member's episode can play its clips (#1696)", async ({
  browser,
}) => {
  test.slow(); // an upload plus first-hit route compiles, across two sessions
  // The mismatch this covers: the episode page resolves an episode across the viewer's
  // ACCESSIBLE profiles (#879), but the media route scoped its lookup to the ACTIVE one —
  // so the strip mounted for a caregiver while every byte request 404'd. Reuses the
  // household-history caregiver (granted a well parent, its active profile, plus the
  // currently-sick child) rather than minting another fixture login; the child's OPEN
  // "Cold" is the cross-profile episode, and this spec deletes the clip it attaches.
  const childId = profileId(HH_HISTORY_CHILD_PROFILE);
  const episodeId = withDb(
    (h) =>
      (
        h
          .prepare(
            `SELECT id FROM illness_episodes
              WHERE profile_id = ? AND ended_at IS NULL
              ORDER BY id DESC LIMIT 1`
          )
          .get(childId) as { id: number }
      ).id
  );

  const page = await loginAs(browser, {
    username: E2E_LOGIN_HHHIST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto(`/medical/episodes/${episodeId}`);
    // Identity rides ON the page: this is the CHILD's episode read while acting as the
    // parent — the exact posture that used to break the clips.
    await expect(page.getByTestId("episode-subject-name")).toHaveText(
      HH_HISTORY_CHILD_PROFILE
    );
    await expect(page.getByTestId("episode-switch-profile")).toBeVisible();

    const strip = page.getByTestId("symptom-video-strip");
    await expect(strip).toBeVisible();
    await strip.getByTestId("video-clip-input").setInputFiles({
      name: "cough.mp4",
      mimeType: "video/mp4",
      buffer: buildMp4Fixture({ durationSec: 7 }),
    });
    await expect(page.getByText("Clip attached.")).toBeVisible({
      timeout: 20_000,
    }); // named ceiling: the cross-profile upload rides a Server Action + router.refresh()

    const clip = latestClip(childId);
    const tile = strip.getByTestId(`video-clip-item-${clip.id}`);
    await expect(tile).toBeVisible({ timeout: 20_000 }); // named ceiling: the tile appears with the revalidated RSC

    // THE regression: the bytes serve to a caregiver whose ACTIVE profile is not the
    // clip's owner, because the route now resolves the owner and gates on access to it.
    const served = await page.request.get(`/api/symptom-video/${clip.id}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["accept-ranges"]).toBe("bytes");

    // The grants boundary is untouched: a login with NO grant on the child gets the same
    // "not found" JSON it would get for an id that does not exist.
    const outsider = await loginAs(browser, {
      username: E2E_LOGIN_SICK_VIDEO,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      const denied = await outsider.request.get(
        `/api/symptom-video/${clip.id}`
      );
      expect(denied.status()).toBe(404);
      expect(await denied.json()).toEqual({ ok: false, error: "not found" });
    } finally {
      await outsider.context().close();
    }

    // Own what this test attached — the cross-profile delete gates on the child too.
    await settledClick(page, tile.getByTestId(`video-clip-delete-${clip.id}`));
    await expect(
      strip.locator('[data-testid^="video-clip-item-"]')
    ).toHaveCount(0, { timeout: 20_000 }); // named ceiling: the delete rides a Server Action + router.refresh()
  } finally {
    clearClips(HH_HISTORY_CHILD_PROFILE);
    await page.context().close();
  }
});
