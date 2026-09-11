import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { awaitHydrated, openFoodAdd } from "./helpers";
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

// THE REMEMBERED-OPEN DISCLOSURE WAS THE TAIL'S (#5435 §4).
//
// This asserted that a disclosure remembered open on this device stays FULLY open as
// its content grows — the `::details-content` case where a remembered height from a
// previous render clips the taller content behind it. Its subject was
// `dashboard-all`, the "Show everything" fold, which is the only disclosure in this
// app that persists its open state per device; §4 retires it with the ranker.
//
// WHAT RETIRED WITH IT: the remembered-height claim, which needs a REMEMBERED
// disclosure and has no other instance in the tree. What did not: the two cases above
// it — a disclosure animating without delaying its content, and reduced motion opening
// instantly and scheduling no keyframe — which run on ordinary folds and are the
// motion contract itself.
