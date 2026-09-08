import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_LOGIN_DASHBOARD_ALL, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { test, expect } from "./fixtures";
import {
  awaitHydrated,
  dashboardAllSummary,
  hydratedClick,
  openFoodAdd,
} from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import {
  CONTINUITY_MOTIONS,
  MICRO_MOTIONS,
  MICRO_MOTION_MAX_MS,
  MICRO_MOTION_MIN_MS,
} from "@/lib/micro-motion";

// Sample real frame geometry: user-opened disclosures interpolate between heights,
// while remembered disclosures must already contain their content at first paint.
// Track node replacement so detached geometry cannot masquerade as no animation.
/** One height sample per animation frame, taken from inside the page. */
async function heightsWhileOpening(
  page: Page,
  selector: string,
  summarySelector: string,
  frames: number
): Promise<{ samples: number[]; replaced: boolean }> {
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
      return {
        samples,
        replaced: document.querySelector(sel as string) !== el,
      };
    },
    [selector, summarySelector, frames] as const
  );
}

/** The sampler's reading, said in a way a reader can act on. */
function heightStory(
  label: string,
  reading: { samples: number[]; replaced: boolean }
): string {
  return (
    `${label}: ${reading.samples.join(",")}` +
    (reading.replaced
      ? ` — THE SAMPLED NODE WAS REPLACED while the frames ran, so these heights ` +
        `are a detached element's and say nothing about the motion (#4339).`
      : "")
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

test("a disclosure animates without delaying its content or controls", async ({
  page,
}) => {
  // 430px: the phone width the issue names, where these folds open into a long list
  // and the snap was a full-height jump with the reader's finger still on the summary.
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/nutrition");
  await openFoodAdd(page);
  const more = page.locator(MORE_GROUPS);
  await awaitHydrated(more);
  await expect(more).not.toHaveAttribute("open", "");

  const visibleControls = () =>
    more
      .locator("button, a[href], input, select, textarea")
      .evaluateAll((els) => els.filter((el) => el.checkVisibility()).length);
  expect(await visibleControls()).toBe(0);

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
    growthFrames(opening.samples).length,
    heightStory("heights while opening", opening)
  ).toBeGreaterThan(0);
  expect(opening.samples.at(-1)).toBeGreaterThan(opening.samples[0]);
  await expect(more).toHaveAttribute("open", "");
  expect(await visibleControls()).toBeGreaterThan(0);

  // And closing is the same motion in reverse — the half a JS-driven collapse
  // usually gets wrong, because the element has to stay open while it shrinks.
  const closing = await heightsWhileOpening(
    page,
    MORE_GROUPS,
    MORE_GROUPS_SUMMARY,
    30
  );
  expect(
    growthFrames(closing.samples).length,
    heightStory("heights while closing", closing)
  ).toBeGreaterThan(0);
  expect(closing.samples.at(-1)).toBeLessThan(closing.samples[0]);
  await expect(more).not.toHaveAttribute("open", "");

  // Opening is one state: the content becomes readable in the same task as `open`
  // flips, rather than one rendering opportunity later through a discrete
  // content-visibility transition.
  const onClickFrame = await page.evaluate(
    ([sel, summarySel]) => {
      const el = document.querySelector<HTMLDetailsElement>(sel as string)!;
      const trigger = document.querySelector<HTMLElement>(
        summarySel as string
      )!;
      const heading = () => el.querySelector<HTMLElement>("h3");
      const before = heading()?.innerText.trim().length ?? 0;
      trigger.click();
      const kid = heading();
      return {
        before,
        open: el.open,
        contentVisibility: getComputedStyle(el, "::details-content")
          .contentVisibility,
        innerTextLength: kid?.innerText.trim().length ?? 0,
        visible: kid?.checkVisibility({ contentVisibilityAuto: true }) ?? false,
        // Same discriminator as the sampler's (#4339): a click that lands on a node
        // React has already replaced reads exactly like a content-visibility fault,
        // and `contentVisibility: ""` is the tell.
        stillMounted: document.querySelector(sel as string) === el,
      };
    },
    [MORE_GROUPS, MORE_GROUPS_SUMMARY] as const
  );
  // First, so a replaced node is named as one rather than read as a content
  // -visibility fault: every assertion below is satisfiable by a detached element.
  expect(onClickFrame.stillMounted, JSON.stringify(onClickFrame)).toBe(true);
  expect(onClickFrame.before).toBe(0);
  expect(onClickFrame.open).toBe(true);
  expect(onClickFrame.contentVisibility, JSON.stringify(onClickFrame)).not.toBe(
    "hidden"
  );
  expect(
    onClickFrame.innerTextLength,
    JSON.stringify(onClickFrame)
  ).toBeGreaterThan(0);
  expect(onClickFrame.visible, JSON.stringify(onClickFrame)).toBe(true);

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
    await openFoodAdd(page);
    await awaitHydrated(page.locator(MORE_GROUPS));

    const reading = await heightsWhileOpening(
      page,
      MORE_GROUPS,
      MORE_GROUPS_SUMMARY,
      6
    );
    // The FIRST frame after the tap is already the settled height: no travel, no
    // intermediate, and nothing for a returning glance to wait on.
    expect(
      growthFrames(reading.samples).length,
      heightStory("heights under reduced motion", reading)
    ).toBe(0);
    expect(reading.samples[0]).toBe(reading.samples.at(-1));
    expect(reading.samples[0]).toBeGreaterThan(0);

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

type RestoredFrame = {
  open: boolean;
  visible: boolean;
  overflow: number;
  height: number;
};

test("a remembered-open disclosure stays fully open while its content grows", async ({
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
    await hydratedClick(page, dashboardAllSummary(page));
    await expect(details).toHaveAttribute("open", "");

    // Sample from the first frame the fold exists. Grow its content after sampling
    // to exercise streamed layout changes without mistaking them for an entrance.
    await page.addInitScript(() => {
      const bag = window as typeof window & {
        __discloseFrames?: RestoredFrame[];
      };
      bag.__discloseFrames = [];
      let grew = false;
      const sample = () => {
        const el = document.querySelector<HTMLDetailsElement>(
          '[data-testid="dashboard-all"]'
        );
        if (el) {
          const box = el.getBoundingClientRect();
          const content = el.querySelector<HTMLElement>(
            '[data-testid="dashboard-all-contents"]'
          );
          bag.__discloseFrames!.push({
            open: el.open,
            visible: content?.checkVisibility() ?? true,
            overflow: content
              ? Math.max(0, content.getBoundingClientRect().bottom - box.bottom)
              : 0,
            height: box.height,
          });
          if (content && !grew) {
            content.style.minHeight = `${Math.max(2000, box.height * 3)}px`;
            grew = true;
          }
        }
        if (bag.__discloseFrames!.length < 20) requestAnimationFrame(sample);
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
              (window as typeof window & { __discloseFrames?: RestoredFrame[] })
                .__discloseFrames?.length ?? 0
          ),
        { message: "the first-frames sampler never ran" }
      )
      .toBeGreaterThanOrEqual(10);
    const frames = await page.evaluate(
      () =>
        (window as typeof window & { __discloseFrames?: RestoredFrame[] })
          .__discloseFrames ?? []
    );
    // The growing fixture would fail the old first-height / final-height threshold.
    expect(Math.max(...frames.map((frame) => frame.height))).toBeGreaterThan(
      frames[0].height * 2
    );
    // An entrance clips natural content below the interpolating details box. Compare
    // within each frame: streamed content and font/layout changes can change both.
    expect(
      frames.every(
        (frame) => frame.open && frame.visible && frame.overflow <= 1
      ),
      JSON.stringify(frames)
    ).toBe(true);
  } finally {
    await page.context().close();
  }
});
