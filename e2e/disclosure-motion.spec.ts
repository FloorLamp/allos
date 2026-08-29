import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_LOGIN_DASHBOARD_ALL, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import {
  CONTINUITY_MOTIONS,
  MICRO_MOTIONS,
  MICRO_MOTION_MAX_MS,
  MICRO_MOTION_MIN_MS,
} from "@/lib/micro-motion";

// THE CONTINUITY MOTION, MEASURED (#3676 / #3677).
//
// Every disclosure in the app now grows open through `components/Disclosure.tsx`
// instead of snapping. The class is defined by two properties that only a browser can
// answer, and BOTH of them are heights over frames rather than events: Chromium does
// not expose a `::details-content` transition through `getAnimations()` or through
// `transitionrun`, which was measured before this spec was written. So each test
// samples the disclosure's own height once per animation frame, inside the page, and
// reads the SHAPE of the sequence.
//
//   * It ANIMATES: at least one frame sits strictly between closed and open. A snap
//     produces no such frame, which is exactly what every one of these folds did
//     before.
//   * It does not REPLAY. A fold restored open by the pre-paint memory script must be
//     open on the first frame and never move — an entrance on load is the ambient
//     motion #3676 refuses, and "it does not animate" is only worth asserting if the
//     assertion could have failed, so the same sampler that catches growth is pointed
//     at the load.
//
// Under reduced motion the same sampler must find the panel at full height on the
// FIRST frame after the tap, which is the designed end state rather than an absence.

/** One height sample per animation frame, taken from inside the page. */
async function heightsWhileOpening(
  page: Page,
  selector: string,
  summarySelector: string,
  frames: number
): Promise<number[]> {
  return page.evaluate(
    async ([sel, summarySel, count]) => {
      const el = document.querySelector<HTMLElement>(sel as string);
      const summary = document.querySelector<HTMLElement>(summarySel as string);
      if (!el || !summary) throw new Error(`missing ${sel} / ${summarySel}`);
      const samples: number[] = [];
      summary.click();
      for (let i = 0; i < (count as number); i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        samples.push(el.getBoundingClientRect().height);
      }
      return samples;
    },
    [selector, summarySelector, frames] as const
  );
}

/** Frames strictly between the closed height and the settled one. */
function growthFrames(samples: number[]): number[] {
  const closed = Math.min(...samples);
  const open = Math.max(...samples);
  return samples.filter((h) => h > closed + 1 && h < open - 1);
}

function resetDashboardAllOffer(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT p.id
           FROM profiles p
           JOIN login_profiles lp ON lp.profile_id = p.id
           JOIN logins l ON l.id = lp.login_id
          WHERE l.username = ?`
      )
      .get(E2E_LOGIN_DASHBOARD_ALL) as { id: number };
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'stream-onboard:%'"
    ).run(profile.id);
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'wear_reminder_enabled'"
    ).run(profile.id);
  } finally {
    db.close();
  }
}

const MORE_GROUPS = '[data-testid="food-more-groups"]';
const MORE_GROUPS_SUMMARY = '[data-testid="food-more-groups-summary"]';

test("a disclosure grows open rather than snapping, and settles inside the band", async ({
  page,
}) => {
  // 430px: the phone width the issue names, where these folds open into a long list
  // and the snap was a full-height jump with the reader's finger still on the summary.
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/nutrition");
  await expect(page.locator(MORE_GROUPS)).toBeVisible();
  await expect(page.locator(MORE_GROUPS)).not.toHaveAttribute("open", "");

  // 30 frames is ~500ms at 60fps and more on a loaded box — comfortably past the
  // 200ms token either way, so the last samples are the settled height whatever the
  // frame budget turns out to be.
  const opening = await heightsWhileOpening(
    page,
    MORE_GROUPS,
    MORE_GROUPS_SUMMARY,
    30
  );
  expect(
    growthFrames(opening).length,
    `heights while opening: ${opening.join(",")}`
  ).toBeGreaterThan(0);
  expect(opening.at(-1)).toBeGreaterThan(opening[0]);
  await expect(page.locator(MORE_GROUPS)).toHaveAttribute("open", "");

  // And closing is the same motion in reverse — the half a JS-driven collapse
  // usually gets wrong, because the element has to stay open while it shrinks.
  const closing = await heightsWhileOpening(
    page,
    MORE_GROUPS,
    MORE_GROUPS_SUMMARY,
    30
  );
  expect(
    growthFrames(closing).length,
    `heights while closing: ${closing.join(",")}`
  ).toBeGreaterThan(0);
  expect(closing.at(-1)).toBeLessThan(closing[0]);
  await expect(page.locator(MORE_GROUPS)).not.toHaveAttribute("open", "");

  // The band is the doctrine's, not this spec's: the token is the single source and
  // the unit tier pins it to the stylesheet. Asserted here so a re-timing that
  // escaped the band would fail where the motion is actually watched, too.
  expect(CONTINUITY_MOTIONS.disclose.ms).toBeGreaterThanOrEqual(
    MICRO_MOTION_MIN_MS
  );
  expect(CONTINUITY_MOTIONS.disclose.ms).toBeLessThanOrEqual(
    MICRO_MOTION_MAX_MS
  );
});

test("reduced motion opens the panel instantly, and schedules no keyframe", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 430, height: 900 });
    await page.goto("/nutrition");
    await expect(page.locator(MORE_GROUPS)).toBeVisible();

    const samples = await heightsWhileOpening(
      page,
      MORE_GROUPS,
      MORE_GROUPS_SUMMARY,
      6
    );
    // The FIRST frame after the tap is already the settled height: no travel, no
    // intermediate, and nothing for a returning glance to wait on.
    expect(
      growthFrames(samples).length,
      `heights under reduced motion: ${samples.join(",")}`
    ).toBe(0);
    expect(samples[0]).toBe(samples.at(-1));
    expect(samples[0]).toBeGreaterThan(0);

    // One adopter of EACH class on one page (#3676's acceptance). The continuity
    // class is the disclosure above, which KEEPS its class under the preference and
    // is neutralized by the stylesheet — a server component cannot read the
    // preference, and that is the belt-and-braces the doctrine already describes.
    await expect(page.locator(MORE_GROUPS)).toHaveClass(/motion-disclose/);
    // The information class is the seven keyframe motions, and `/nutrition` is where
    // the settle and count tenants live. None is scheduled, by name and by the
    // browser's own animation list.
    for (const kind of Object.keys(MICRO_MOTIONS)) {
      expect(await page.locator(`.motion-${kind}`).count(), kind).toBe(0);
    }
    expect(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.constructor.name === "CSSAnimation").length
      )
    ).toBe(0);
  } finally {
    await context.close();
  }
});

test("a remembered-open disclosure is open on the first painted frame and never replays", async ({
  browser,
}) => {
  resetDashboardAllOffer();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DASHBOARD_ALL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const details = page.getByTestId("dashboard-all");
    await expect(details).not.toHaveAttribute("open", "");
    await hydratedClick(page, details.locator("summary"));
    await expect(details).toHaveAttribute("open", "");

    // Sample from the earliest frame the element exists in, on the RELOAD. If the
    // restore replayed its entrance, the first frames would climb — the very shape
    // the opening test above proves this sampler can see.
    await page.addInitScript(() => {
      const bag = window as typeof window & { __discloseHeights?: number[] };
      bag.__discloseHeights = [];
      const sample = () => {
        const el = document.querySelector<HTMLElement>(
          '[data-testid="dashboard-all"]'
        );
        if (el) bag.__discloseHeights!.push(el.getBoundingClientRect().height);
        if ((bag.__discloseHeights?.length ?? 0) < 20)
          requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.reload();
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByTestId("dashboard-all-contents")).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as typeof window & { __discloseHeights?: number[] })
                .__discloseHeights?.length ?? 0
          ),
        { message: "the first-frames sampler never ran" }
      )
      .toBeGreaterThanOrEqual(10);
    const heights = await page.evaluate(
      () =>
        (window as typeof window & { __discloseHeights?: number[] })
          .__discloseHeights ?? []
    );
    // Already at its full height on the first frame it exists in, and unmoved after.
    // The content streams in around it, so the panel may still be GROWING with its
    // own rows — what may not happen is the panel starting near zero, which is what
    // an entrance replay looks like.
    expect(heights[0], `first frames: ${heights.join(",")}`).toBeGreaterThan(
      Math.max(...heights) / 2
    );
    expect(growthFrames(heights).length, heights.join(",")).toBe(0);
  } finally {
    await page.context().close();
  }
});

test("a collapsed disclosure keeps its controls out of the tab order", async ({
  page,
}) => {
  await page.goto("/nutrition");
  const more = page.locator(MORE_GROUPS);
  await expect(more).toBeVisible();
  await expect(more).not.toHaveAttribute("open", "");

  // `Collapse`'s guarantee, inherited: a collapsed panel whose buttons are still
  // tabbable is a keyboard trap you cannot see. The native element does this for the
  // disclosure, and the animation must not have re-mounted the content outside it.
  const hidden = await more
    .locator("button, a[href], input, select, textarea")
    .evaluateAll((els) => els.filter((el) => el.checkVisibility()).length);
  expect(hidden).toBe(0);

  await page.locator(MORE_GROUPS_SUMMARY).click();
  await expect(more).toHaveAttribute("open", "");
  const shown = await more
    .locator("button, a[href], input, select, textarea")
    .evaluateAll((els) => els.filter((el) => el.checkVisibility()).length);
  // The converse, in the same commit: an absence assertion that passes on a tree
  // where the panel simply has no controls proves nothing.
  expect(shown).toBeGreaterThan(0);
});
