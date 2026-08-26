import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { deleteActivityFromForm, settledBoxes } from "./helpers";
import {
  E2E_LOGIN_OVERVIEW_NO_ROUTINE,
  E2E_LOGIN_OVERVIEW_REST,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";

async function expectStandingActions(page: Page): Promise<void> {
  const card = page.getByTestId("next-workout-card");
  const answer = card.getByTestId("next-workout-title");
  const actions = card.getByTestId("training-overview-actions");
  const context = card.getByTestId("training-context-chips");

  await expect(answer).toBeVisible();
  await expect(
    actions.getByTestId("training-overview-start-workout")
  ).toBeVisible();
  await expect(
    actions.getByTestId("training-overview-start-workout")
  ).toHaveText("Start workout");
  await expect(
    actions.getByTestId("training-overview-log-activity")
  ).toBeVisible();
  await expect(context).toBeVisible();
  await expect(context.getByTestId("training-context-chip")).toContainText(
    "Legs (Right knee (e2e) injury)"
  );
  expect(
    await card.evaluate((element) => {
      const title = element.querySelector('[data-testid="next-workout-title"]');
      const chips = element.querySelector(
        '[data-testid="training-context-chips"]'
      );
      return Boolean(
        title &&
        chips &&
        title.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
}

// The discard goes through `deleteActivityFromForm` (#3454) — the form unmounting is
// a client `setState` and says nothing about whether `deleteActivity` has run, so the
// old spelling left the live draft racing this spec's own teardown guard.
async function closeEmptyLiveWorkout(page: Page): Promise<void> {
  await deleteActivityFromForm(page);
}

test("a no-routine Overview answers first and keeps both logging doors (#3062)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_NO_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    await expect(page.getByTestId("todays-session-card")).toHaveCount(0);
    await expectStandingActions(page);

    await page.getByTestId("training-overview-start-workout").click();
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();
    await page.waitForURL(/\/training\/activity\/\d+$/);

    await closeEmptyLiveWorkout(page);

    await page.goto("/training?tab=overview");
    await page.getByTestId("training-overview-log-activity").click();
    await expect(page.getByTestId("activity-form")).toBeVisible();
    await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);
  } finally {
    await page.close();
  }
});

test("a rest recommendation keeps the answer ahead of context and both doors (#3062)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_REST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    await expect(page.getByTestId("next-workout-title")).toContainText(/rest/i);
    await expectStandingActions(page);
  } finally {
    await page.close();
  }
});

// ── THE CARD'S ACTION BLOCK, MEASURED AS A RENDERED LAYOUT (issue #3473) ─────
//
// At phone width the next-workout card used to spend three lines on three
// controls of DESCENDING importance, because its `md`+ right-hand rail is a
// column and the column came down with it. Owner ruling 2026-08-21: below `md`
// the primary keeps its own line and the two ghost controls share the one
// beneath it; at `md`+ the rail renders exactly as before.
//
// THE BOUNDARY IS `md`, AND IT IS NOT `CARD_MODE_BREAKPOINT_PX`. That constant
// (`sm`, lib/card-row.ts, #3457) is where a `.table-cards` TABLE stops being a
// table. This is a card's action rail collapsing under its own text — the card's
// `md` seam in OverviewSection — which docs/internals/design-system.md §5 lists
// as its own idiom ("Text + trailing actions"). The two readings either side of
// RAIL_BREAKPOINT_PX below are what goes red if someone "corrects" this rail to
// the card-mode boundary: the rail would then be back by 640px, and the reading
// at NARROW_WIDTH would report it.
//
// A CLASS-LIST CHECK WOULD NOT DO. A computed style is a DECLARATION and the
// reader gets a RESULT — this tree has already shipped a green declaration over
// a wrong render (#3466). So the probe reads `getBoundingClientRect()` and
// counts the vertical BANDS the controls occupy, the discriminator
// e2e/card-mode-boundary.spec.ts uses, including the part where the opposite
// arrangement is FORGED at the same width and the probe is required to report
// it. A probe that cannot fail is not evidence.
//
// It runs in the DESKTOP project on purpose: the subject is a range of widths,
// not a phone, and it sets each one itself.

// Tailwind's `md` (48rem) — the card's own `flex-col`→row seam. Every width here
// is derived from it, and "the rail arrives exactly at the boundary" below
// CROSS-CHECKS the number against what the card renders (`besideText`) instead
// of trusting it: if `md` moved, that test fails on the seam rather than going
// quietly green about the wrong width.
const RAIL_BREAKPOINT_PX = 768;
const VIEWPORT_HEIGHT = 900;
// The width the `mobile` project uses. Well inside the boundary rather than one
// pixel from it, so this and the edge reading below fail for different reasons.
const PHONE_WIDTH = 390;
// The last width below the boundary, and the first one at it.
const NARROW_WIDTH = RAIL_BREAKPOINT_PX - 1;
// Comfortably above it — the desktop project's own viewport.
const DESKTOP_WIDTH = 1280;

const PRIMARY = "training-overview-start-workout";
const GHOSTS = ["training-overview-log-activity", "next-workout-details"];
const ALL_ACTIONS = [PRIMARY, ...GHOSTS];

interface RailProbe {
  /** Every interactive control in the card outside its context chips. The corpus. */
  controls: string[];
  /** Those controls bucketed by vertical overlap: one entry per band, top down. */
  bands: string[][];
  /** First control's top to last control's bottom — what the block costs. */
  blockHeight: number;
  /** True when the controls sit BESIDE the card's text rather than under it. */
  besideText: boolean;
  /** Rounded right edges, in DOM order — the rail's right-alignment, measured. */
  rightEdges: number[];
}

/**
 * Read the action block's rendered shape. No class names, no computed styles.
 *
 * `bands` is the load-bearing reading and it comes from geometry alone: controls
 * whose vertical intervals overlap are on one rendered line, even when their
 * closed primitives own different heights. Stacked controls report several
 * bands. The corpus is every `button`/`a` in the card that is not one of its
 * context chips — scoped to the CARD and not to the actions wrapper on purpose,
 * because which wrapper holds "View details" is exactly what this change moves,
 * and a probe that assumed the new grouping could not see the old one.
 */
async function probeActions(page: Page): Promise<RailProbe> {
  return page.evaluate(() => {
    const empty: RailProbe = {
      controls: [],
      bands: [],
      blockHeight: 0,
      besideText: false,
      rightEdges: [],
    };
    const card = document.querySelector<HTMLElement>(
      '[data-testid="next-workout-card"]'
    );
    if (!card) return empty;
    const chips = card.querySelector('[data-testid="training-context-chips"]');
    const controls = [
      ...card.querySelectorAll<HTMLElement>("button, a"),
    ].filter((el) => {
      if (chips?.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (controls.length === 0) return empty;
    const name = (el: HTMLElement) =>
      el.dataset.testid ?? (el.textContent ?? "").trim();

    const rects = controls.map((el) => el.getBoundingClientRect());
    const bandRects: { top: number; bottom: number; names: string[] }[] = [];
    for (const { el, rect } of controls
      .map((el, index) => ({ el, rect: rects[index] }))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
      const band = bandRects.find(
        ({ top, bottom }) => rect.top < bottom && rect.bottom > top
      );
      if (band) {
        band.top = Math.min(band.top, rect.top);
        band.bottom = Math.max(band.bottom, rect.bottom);
        band.names.push(name(el));
      } else {
        bandRects.push({
          top: rect.top,
          bottom: rect.bottom,
          names: [name(el)],
        });
      }
    }
    const title = card.querySelector('[data-testid="next-workout-title"]');
    return {
      controls: controls.map(name),
      bands: bandRects.sort((a, b) => a.top - b.top).map(({ names }) => names),
      blockHeight: Math.round(
        Math.max(...rects.map((r) => r.bottom)) -
          Math.min(...rects.map((r) => r.top))
      ),
      besideText: Boolean(
        title &&
        Math.min(...rects.map((r) => r.left)) >=
          title.getBoundingClientRect().right
      ),
      rightEdges: rects.map((r) => Math.round(r.right)),
    };
  });
}

type Arrangement = "primary-then-pair" | "rail-column" | "mixed";

/**
 * The verdict, from the readings alone.
 *
 * Both descriptions name WHICH control is alone at the top, so a layout that
 * put a ghost on the first line and the primary below satisfies neither. A
 * reading that matches nothing is `mixed` — reported as itself rather than
 * defaulted to one side, because a half-rearranged block is a real state.
 */
function arrangement(p: RailProbe): Arrangement {
  const sizes = p.bands.map((b) => b.length);
  if (p.bands[0]?.[0] !== PRIMARY) return "mixed";
  if (
    sizes.length === 2 &&
    sizes[1] === 2 &&
    GHOSTS.every((g) => p.bands[1].includes(g))
  )
    return "primary-then-pair";
  if (sizes.length === 3 && sizes.every((n) => n === 1)) return "rail-column";
  return "mixed";
}

// The two forgeries are each other, and both are written as RAW rendered
// properties: a forgery that reused the app's own classes would prove only that
// the class still exists.
//
// FORGE_COLUMN is the defect #3473 reported — every control claiming its whole
// line, whatever wraps it. FORGE_PAIR is the fix imposed on a width that should
// not have it, by turning whichever element groups the ghosts back into a row.
// If a later restructure leaves no such element, FORGE_PAIR forges nothing and
// the desktop test goes RED rather than passing on an unproven probe.
//
// FORGE_PAIR TAKES ALL THREE DECLARATIONS, MEASURED. The direction alone was not
// enough: at `md`+ the rail is sized to fit beside the card text, so a row that
// still wrapped simply put the two ghosts on two lines again and the probe read
// the arrangement it was supposed to be forged away from. The forgery has to give
// the pair a line it fits on — overflowing the rail is fine, the reading is which
// band each control lands in.
const SCOPE = '[data-testid="next-workout-card"]';
const FORGE_COLUMN = `
  ${SCOPE} button, ${SCOPE} a { width: 100% !important; }
`;
const FORGE_PAIR = `
  ${SCOPE} [data-testid="training-overview-actions"] > div {
    flex-direction: row !important;
    flex-wrap: nowrap !important;
    width: max-content !important;
  }
`;

const FORGED_STYLE_ID = "forged-next-workout-actions";

async function forge(page: Page, css: string): Promise<void> {
  await page.evaluate(
    ([id, text]) => {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = text;
      document.head.append(style);
    },
    [FORGED_STYLE_ID, css] as const
  );
}

async function restore(page: Page): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, FORGED_STYLE_ID);
}

/**
 * Assert one width's rendered arrangement, WITH the discriminator attached.
 *
 * "The primary is alone on its line at 390px" is satisfiable by a probe that has
 * gone blind — a renamed testid, a card that never rendered, rect reads that
 * degraded to zeroes — so the discriminator lives here, bound to the assertion,
 * rather than being an extra a call site may skip. Four steps:
 *
 *   (a) WAIT FOR THE CONTROLS BEING MEASURED, not for the card: an action block
 *       that has not rendered yet occupies one band and no lines, which reads as
 *       a perfectly tidy layout (#3384);
 *   (b) the corpus is exactly the three actions this card owns — a fourth
 *       control, or a missing one, fails here and says so;
 *   (c) the arrangement, and which side of the text the block is on;
 *   (d) the OTHER arrangement, forged at this same width, is reported as the
 *       other arrangement. The control runs AFTER the restore, not only before.
 */
async function expectArrangement(
  page: Page,
  opts: {
    width: number;
    expected: Exclude<Arrangement, "mixed">;
    besideText: boolean;
  }
): Promise<{ seen: RailProbe; forged: RailProbe }> {
  await page.setViewportSize({ width: opts.width, height: VIEWPORT_HEIGHT });
  for (const id of ALL_ACTIONS)
    await expect(
      page.getByTestId("next-workout-card").getByTestId(id)
    ).toBeVisible();

  const seen = await probeActions(page);
  const report = `probe at ${opts.width}px: ${JSON.stringify(seen)}`;
  expect(
    [...seen.controls].sort(),
    `${report} — the card's action corpus is not the three controls this spec ` +
      `is about, so every verdict below is about something else.`
  ).toEqual([...ALL_ACTIONS].sort());
  expect(seen.besideText, report).toBe(opts.besideText);
  expect(arrangement(seen), report).toBe(opts.expected);
  // `items-end`, measured, WHEREVER the rail is a rail. Band counting alone
  // accepts a left-aligned column, which is not what this card has at `md`+ and
  // not what "renders exactly as today" means. It belongs here rather than at
  // one call site: the first draft asserted it only at 1280px, and the mutant
  // that drops the pair's `md` column then went red at desktop while the
  // boundary width — where the same defect renders — stayed green.
  if (opts.expected === "rail-column")
    expect(
      new Set(seen.rightEdges).size,
      `at ${opts.width}px the rail's controls no longer share a right edge: ` +
        seen.rightEdges.join(", ")
    ).toBe(1);

  const other =
    opts.expected === "primary-then-pair" ? "rail-column" : "primary-then-pair";
  await forge(
    page,
    opts.expected === "primary-then-pair" ? FORGE_COLUMN : FORGE_PAIR
  );
  const forged = await probeActions(page);
  expect(
    arrangement(forged),
    `a ${other} layout forged at ${opts.width}px was still read as ` +
      `"${arrangement(forged)}". The probe cannot tell the two arrangements ` +
      `apart, so its verdict above meant nothing. Forged probe: ` +
      JSON.stringify(forged)
  ).toBe(other);

  await restore(page);
  expect(arrangement(await probeActions(page)), report).toBe(opts.expected);
  return { seen, forged };
}

test("at phone width the primary keeps its own line and the ghost pair shares the next (#3473)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_NO_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    const { seen, forged } = await expectArrangement(page, {
      width: PHONE_WIDTH,
      expected: "primary-then-pair",
      besideText: false,
    });
    const card = page.getByTestId("next-workout-card");
    const logActivity = card.getByTestId("training-overview-log-activity");
    const details = card.getByTestId("next-workout-details");
    await expect(logActivity).toHaveAttribute("data-button-control", "");
    await expect(logActivity).toHaveAccessibleName("Log activity");
    const [logBox, detailsBox] = await settledBoxes([logActivity, details]);
    expect(
      logBox.width + TAP_FLOOR_FLOAT_EPSILON_PX,
      "Log activity rendered width"
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(
      logBox.height + TAP_FLOOR_FLOAT_EPSILON_PX,
      "Log activity rendered height"
    ).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(logBox.x, "Log activity left viewport edge").toBeGreaterThanOrEqual(
      0
    );
    expect(
      logBox.x + logBox.width,
      "Log activity right viewport edge"
    ).toBeLessThanOrEqual(PHONE_WIDTH);
    const overlapX =
      Math.min(logBox.x + logBox.width, detailsBox.x + detailsBox.width) -
      Math.max(logBox.x, detailsBox.x);
    const overlapY =
      Math.min(logBox.y + logBox.height, detailsBox.y + detailsBox.height) -
      Math.max(logBox.y, detailsBox.y);
    expect(
      overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
        overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
      "Log activity and View details share an interactive point"
    ).toBe(false);
    // WHAT THE REARRANGEMENT IS WORTH, in the units the issue argued in. The
    // three-line block forged at this very width is the layout that shipped, so
    // this is a measured comparison rather than a remembered number.
    expect(
      seen.blockHeight,
      `the two-line block (${seen.blockHeight}px) is not shorter than the ` +
        `three-line one forged beside it (${forged.blockHeight}px)`
    ).toBeLessThan(forged.blockHeight);
  } finally {
    await page.close();
  }
});

test("the rail arrives exactly at the `md` boundary, and not before it (#3473)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_NO_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    // One pixel below: still the phone arrangement, still under the text.
    await expectArrangement(page, {
      width: NARROW_WIDTH,
      expected: "primary-then-pair",
      besideText: false,
    });
    // At the boundary: the column is back and it is beside the text again. The
    // second half is the cross-check on RAIL_BREAKPOINT_PX — the card's own seam
    // and this rail have to be the same number, which is the whole reason the
    // rail keys on `md`.
    await expectArrangement(page, {
      width: RAIL_BREAKPOINT_PX,
      expected: "rail-column",
      besideText: true,
    });
  } finally {
    await page.close();
  }
});

test("at desktop width the rail is unchanged: one control per row, right-aligned (#3473)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_OVERVIEW_NO_ROUTINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    // Three bands, one control each, sharing one right edge — the right-edge
    // half rides in `expectArrangement` with the arrangement it qualifies.
    await expectArrangement(page, {
      width: DESKTOP_WIDTH,
      expected: "rail-column",
      besideText: true,
    });
  } finally {
    await page.close();
  }
});
