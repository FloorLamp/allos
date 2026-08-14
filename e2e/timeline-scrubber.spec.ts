import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledBoxes } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// THE TIMELINE JUMP RAIL (issue #2657 item 4).
//
// The windowed feed (#2685/#2741) is a spine of period cards, and this is the rail
// that scrubs it: a slim right-edge strip, no text at rest, a bubble naming the period
// under the finger during a drag. Four claims from the ruling are only checkable in a
// browser, and each of them is the kind a component quietly gets wrong:
//
//   1. AT REST, NO TEXT. The strip carries dots and marks; the bubble does not exist
//      until a pointer is down on it.
//   2. THE HIT AREA IS 44px WIDE while the visual is a hairline — and, because a 44px
//      invisible target parked over the feed's own links would be a worse defect than
//      no rail at all, the feed gives up a gutter of exactly that width.
//   3. RELEASING A DRAG ONLY POSITIONS THE SCROLL. A drag across half the history must
//      leave `?open=` byte-identical: scrubbing never mutates open/closed state.
//   4. A PLAIN TAP JUMPS AND EXPANDS. Same strip, same pixel, different gesture,
//      different power.
//
// Plus the one the tick set turns on: a month sealed inside a collapsed year card is
// NOT a stop, and becomes one the moment the year opens.
//
// GESTURES ARE DRIVEN WITH `page.mouse`, deliberately. The rail listens for POINTER
// events, and Chromium's mouse pipeline emits real ones (`pointerType: "mouse"`) that
// the handler does not discriminate on — unlike the shell's swipe recognizers, which
// ignore mouse on purpose and therefore need CDP touch (`touchSwipe`). Driving the
// rail through the simpler channel proves the same handlers with far less to go wrong.
//
// Fixture-OWNED (#868): four goals on the shared default profile, spread so that
// `?category=goal` has a deterministic spine — one future, three in distinct older
// months of the current year, one comfortably inside the previous calendar year.
// Planted in beforeAll, removed in afterAll, so both the ABSENCES and the PRESENCES
// this spec asserts are its own rather than the seed's.

const DB_PATH = workerDbPath();
const GOALS = {
  ahead: "E2E scrubber ahead goal",
  mid: "E2E scrubber mid goal",
  older: "E2E scrubber older goal",
  oldest: "E2E scrubber oldest goal",
  lastYear: "E2E scrubber last year goal",
} as const;

function shiftedDay(days: number): string {
  const d = new Date(frozenNow());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Distances chosen so no profile timezone can move any of them across the "after
// today" edge, the 14-day recent edge, a month boundary or a 1 January.
const DATES = {
  ahead: shiftedDay(45),
  mid: shiftedDay(-100),
  older: shiftedDay(-160),
  oldest: shiftedDay(-220),
  lastYear: shiftedDay(-400),
} as const;

const MID_MONTH = DATES.mid.slice(0, 7);
const OLDEST_MONTH = DATES.oldest.slice(0, 7);
const LAST_YEAR_MONTH = DATES.lastYear.slice(0, 7);
const LAST_YEAR = DATES.lastYear.slice(0, 4);

const FEED = "/timeline?category=goal" as const;

function withDb<T>(fn: (handle: Database.Database) => T): T {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

function cleanup(): void {
  const titles = Object.values(GOALS);
  withDb((db) => {
    db.prepare(
      `DELETE FROM goals WHERE title IN (${titles.map(() => "?").join(",")})`
    ).run(...titles);
  });
}

function seed(): void {
  cleanup();
  withDb((db) => {
    const insert = db.prepare(
      `INSERT INTO goals (profile_id, title, target_date, status)
       VALUES (1, ?, ?, 'active')`
    );
    for (const key of Object.keys(GOALS) as (keyof typeof GOALS)[]) {
      insert.run(GOALS[key], DATES[key]);
    }
  });
}

const strip = (page: Page) => page.getByTestId("timeline-scrubber");
const bubble = (page: Page) => page.getByTestId("timeline-scrubber-bubble");

// The rail is server-rendered with no geometry in it — the anchors' offsets are a
// measurement it can only take in the browser, after hydration. It DECLARES when it
// has one (`data-scrubber-ready`), so every gesture below waits on that state rather
// than on a duration: a drag issued in the pre-measurement window would scrub against
// an empty stop space, which is a bug that looks exactly like a slow machine.
async function railReady(page: Page) {
  await expect(strip(page)).toHaveAttribute("data-scrubber-ready", "true");
}

// The strip's box, settled — every gesture below is expressed as a fraction of it, and
// a box read while the feed is still laying out belongs to no layout that existed.
async function stripBox(page: Page) {
  await railReady(page);
  const [box] = await settledBoxes([strip(page)]);
  return box;
}

// Press the rail at `fraction` of its height and hold. Returns the pressed point so a
// caller can release on exactly the same pixel (a tap) or travel from it (a drag).
async function pressRail(
  page: Page,
  fraction: number
): Promise<{ x: number; y: number }> {
  const box = await stripBox(page);
  const point = {
    x: box.x + box.width / 2,
    y: box.y + box.height * fraction,
  };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}

test.describe("timeline jump rail (#2657 item 4)", () => {
  test.beforeAll(seed);
  test.afterAll(cleanup);

  test("is a text-free hairline at rest, on a 44px target that the feed makes room for", async ({
    page,
  }) => {
    await page.goto(FEED);

    const rail = strip(page);
    await expect(rail).toBeVisible();
    await railReady(page);
    // "At rest, no text" — the strip's whole subtree, not just its own node.
    await expect(rail).toHaveText("");
    await expect(bubble(page)).toHaveCount(0);

    // The touch-target floor, decoupled from the ~5px visual. Asserted on the box
    // rather than on a class, because the class is not what a finger hits.
    const [railBox, dot] = await settledBoxes([
      rail,
      page.getByTestId(`timeline-scrubber-tick-${MID_MONTH}`),
    ]);
    expect(railBox.width).toBe(44);
    expect(dot.width).toBeLessThan(20);

    // …and the feed gives up exactly that column, so the invisible strip is never
    // parked on top of a card's own links. This is the claim that makes a 44px
    // target safe at all.
    const [card] = await settledBoxes([
      page.getByTestId(`timeline-fold-${MID_MONTH}`),
    ]);
    expect(card.x + card.width).toBeLessThanOrEqual(railBox.x);
  });

  test("announces the period it is pointing at, as a slider", async ({
    page,
  }) => {
    await page.goto(FEED);

    const rail = strip(page);
    await railReady(page);
    // Supplementary navigation, per the ruling — but a role that announces a value
    // still has to announce a real one, spelled out rather than the bubble's terse
    // "MAR 2026" (a screen reader saying "M-A-R" is not a period name).
    await expect(rail).toHaveAttribute("role", "slider");
    await expect(rail).toHaveAttribute("aria-orientation", "vertical");
    await expect(rail).toHaveAttribute("aria-label", /month/i);
    await expect(rail).toHaveAttribute("title", /month/i);
    await expect(rail).toHaveAttribute(
      "aria-valuetext",
      /^([A-Z][a-z]+ )?\d{4}$/
    );
  });

  test("names the period under the finger during a drag, and nothing at rest", async ({
    page,
  }) => {
    await page.goto(FEED);

    const box = await stripBox(page);
    await pressRail(page, 0.05);
    await expect(bubble(page)).toBeVisible();
    // Terse and uppercase — "MAR 2026", or a bare year over a collapsed year card.
    await expect(bubble(page)).toHaveText(/^([A-Z]{3} )?\d{4}$/);

    const first = await bubble(page).textContent();
    // Travel to the bottom of the rail: past the last month and into the year card,
    // so the period under the finger is certainly a different one.
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height * (0.05 + (0.9 * step) / 8)
      );
    }
    await expect(bubble(page)).not.toHaveText(first ?? "");
    // The beat only ever plays on a CROSSING, so its class is the receipt that one
    // happened — the bubble merely appearing must not spend it.
    await expect(bubble(page).locator("span")).toHaveClass(/motion-tick/);

    await page.mouse.up();
    // Back to silence: the label is a drag affordance, not a permanent readout.
    await expect(bubble(page)).toHaveCount(0);
  });

  test("a released drag positions the scroll and expands NOTHING", async ({
    page,
  }) => {
    await page.goto(FEED);
    const before = page.url();
    const month = page.getByTestId(`timeline-fold-${OLDEST_MONTH}`);
    await expect(month).toHaveAttribute("data-fold-open", "false");

    const box = await stripBox(page);
    await pressRail(page, 0.02);
    for (let step = 1; step <= 10; step++) {
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height * (0.02 + (0.95 * step) / 10)
      );
    }
    await page.mouse.up();

    // The scroll moved…
    await expect
      .poll(async () => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    // …and nothing else did. A reader who drags past eleven months must not arrive
    // with eleven months unfolded, which is why the gesture, not the position,
    // decides whether `?open=` may change.
    expect(page.url()).toBe(before);
    await expect(month).toHaveAttribute("data-fold-open", "false");
    await expect(page.getByText(GOALS.oldest)).toHaveCount(0);
  });

  test("a plain tap jumps to the month and expands it on arrival", async ({
    page,
  }) => {
    await page.goto(FEED);
    await expect(page.getByText(GOALS.mid)).toHaveCount(0);

    // Aim at the dot itself: placement and selection read the same fractions, so the
    // period a tap lands on IS the dot under the pointer.
    await railReady(page);
    const [railBox, dot] = await settledBoxes([
      strip(page),
      page.getByTestId(`timeline-scrubber-tick-${MID_MONTH}`),
    ]);
    const x = railBox.x + railBox.width / 2;
    const y = dot.y + dot.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Released on the same pixel: zero travel, so this is unambiguously a tap.
    await page.mouse.up();

    await expect(page).toHaveURL(new RegExp(`open=${MID_MONTH}`));
    await expect(
      page.getByTestId(`timeline-fold-${MID_MONTH}-toggle`)
    ).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(GOALS.mid)).toBeVisible();
  });

  test("offers no stop for a month sealed inside a collapsed year", async ({
    page,
  }) => {
    await page.goto(FEED);

    // The ruling's sharpest clause: no phantom ticks for content no scroll can reach.
    // The year card is a stop; the month inside it is not in the document at all.
    await expect(
      page.getByTestId(`timeline-scrubber-tick-${LAST_YEAR}`)
    ).toHaveCount(1);
    await expect(
      page.getByTestId(`timeline-scrubber-tick-${LAST_YEAR_MONTH}`)
    ).toHaveCount(0);

    // Open the year and the tick set changes underneath the rail — "recomputed on
    // every expand/collapse", which it gets for free because expansion is URL state.
    await page.goto(`${FEED}&open=${LAST_YEAR}`);
    await expect(
      page.getByTestId(`timeline-scrubber-tick-${LAST_YEAR_MONTH}`)
    ).toHaveCount(1);
    await expect(
      page.getByTestId(`timeline-scrubber-tick-${LAST_YEAR}`)
    ).toHaveCount(0);
  });
});

test.describe("timeline jump rail under reduced motion (#2657 item 4)", () => {
  // The harness builds its own contexts (DB-per-worker), so the preference rides in
  // through `contextOptions` rather than the bare `reducedMotion` test option — the
  // same shape e2e/micro-motion.spec.ts uses.
  test.use({ contextOptions: { reducedMotion: "reduce" } });
  test.beforeAll(seed);
  test.afterAll(cleanup);

  test("keeps the period name and drops the beat", async ({ page }) => {
    // Rule 3 of the micro-motion vocabulary: reduced motion is the DESIGNED state.
    // The bubble still names every period the finger crosses — the text is the
    // carrier, and it is the only one iOS ever had anyway.
    await page.goto(FEED);

    const box = await stripBox(page);
    await pressRail(page, 0.05);
    const first = await bubble(page).textContent();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height * (0.05 + (0.9 * step) / 8)
      );
    }
    await expect(bubble(page)).not.toHaveText(first ?? "");
    await expect(bubble(page).locator("span")).not.toHaveClass(/motion-tick/);
    await page.mouse.up();
  });
});
