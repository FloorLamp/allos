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

// WHY THE SAMPLER REPORTS WHETHER ITS NODE IS STILL THE MOUNTED ONE (#4339).
//
// It resolves the fold ONCE and then measures that node for every frame — it has to,
// because the whole point is one continuous element travelling. So if React replaces
// the subtree while the frames run, this measures a node that is no longer in the
// document: a detached element reports height 0 forever, and `growthFrames` on
// `0,0,0,…` is empty. The assertion below then reads "the fold did not animate" when
// what happened is "the fold I was holding stopped being the fold".
//
// Those two are indistinguishable in the failure text, and that cost this issue three
// weeks: run 33337869481 shard 4 failed with `heights while opening: 0,0,…,0` and with
// `{"contentVisibility":"","innerTextLength":8,"visible":false}` and neither said which
// one it was. Forging each candidate state on this page settles it — only a DETACHED
// node reports `contentVisibility: ""` (a display:none one still reports "visible"),
// and only a detached or display:none one reports height 0:
//
//   detach the details      {before:8,open:true,contentVisibility:"",       …} heights 0,0,0…
//   display:none details    {before:8,open:true,contentVisibility:"visible",…} heights 0,0,0…
//   content-visibility:hidden parent                     …contentVisibility:"visible"  heights 525,525…
//   untouched (control)     {before:0,open:true,contentVisibility:"visible",…} heights 164,524,761…
//
// Reviewer: this flag pins nothing and backs no assertion, and it is not scaffolding.
// It is the one line that makes the NEXT occurrence say which failure it is instead of
// sending the reader after a motion regression that never happened.
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
    // The outer control's OWN summary, not "the first summary inside `details`" — a
    // capped Everything band nests its own fold (and its own summary) under this
    // same `<details>` (#4065), which makes the naive `.locator("summary")` ambiguous.
    await hydratedClick(page, dashboardAllSummary(page));
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
