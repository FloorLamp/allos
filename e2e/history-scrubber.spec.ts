import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { expectNoClippedContent, settledBoxes } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";

// THE TIMELINE JUMP RAIL (issue #2657 item 4).
//
// The windowed feed (#2685/#2741) is a spine of period cards, and this is the rail
// that scrubs it: a slim right-edge strip of month dots and labelled year marks, and a
// bubble naming the period under the finger during a drag. Four claims from the ruling are only checkable in a
// browser, and each of them is the kind a component quietly gets wrong:
//
//   1. AT REST THE STRIP CARRIES YEAR DIGITS AND NOTHING ELSE. The owner ruling of
//      2026-08-14 reversed the spec's own "at rest, no text" for year marks only, so
//      the assertion this spec used to make is now exactly wrong: months stay
//      textless, years are labelled, and the bubble still does not exist until a
//      pointer is down.
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
// `?kind=goal` has a deterministic spine — one future, three in distinct older
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

// THE RAIL NEEDS DEPTH, AND `?show=` IS HOW THE RECORD OFFERS IT — but the reason
// this spec has to ask for it is a FINDING, not a preference, so it is written down
// here rather than left as a magic param.
//
// `/timeline?category=goal` pushed the category into the QUERY, so its 250-event
// budget was 250 GOALS and reached back years on any profile. The record narrows in
// memory instead (lib/history.ts: "ONE GATHER, NARROWED IN MEMORY", so `?kind=` cannot
// change which chips the reader is offered), which means a feed-kind view reads the
// newest `show` events across ALL SIXTEEN feed categories and then keeps the goals
// among them. On this shared, densely seeded profile the default 200 covers roughly
// three months, so the fixture's goals at −100/−160/−220/−400 days fall outside it and
// the rail has no spine to draw. Measured: at `show` default the strip does not render
// at all; at 1000 (`HISTORY_MAX_SHOW`, reachable through Load more) every case here
// passes.
//
// That shallowness is the same on every retargeted `?kind=` door and is recorded as an
// open question on #3958. This spec's subject is the RAIL, so it asks for the depth the
// rail exists to navigate rather than asserting the gather's window.
const FEED = "/history?kind=goal&show=1000" as const;

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

test.describe("the record's jump rail (#2657 item 4)", () => {
  test.beforeAll(seed);
  test.afterAll(cleanup);

  test("is a hairline of dots and year digits at rest, on a 44px target the feed makes room for", async ({
    page,
  }) => {
    await page.goto(FEED);

    const rail = strip(page);
    await expect(rail).toBeVisible();
    await railReady(page);
    // At rest the strip's ENTIRE text is year digits — the 2026-08-14 ruling's
    // reversal, bounded. A month name or a count leaking in here would be the
    // labelled button rail the issue prototyped and rejected.
    await expect(rail).toHaveText(/^(\d{4})+$/);
    await expect(
      page.getByTestId(`timeline-scrubber-year-${LAST_YEAR}`)
    ).toBeVisible();
    // …and no bubble until a pointer is down on it.
    await expect(bubble(page)).toHaveCount(0);

    // The touch-target floor, decoupled from the ~5px visual. Asserted on the box
    // rather than on a class, because the class is not what a finger hits.
    const [railBox, dot] = await settledBoxes([
      rail,
      page.getByTestId(`timeline-scrubber-tick-${MID_MONTH}`),
    ]);
    expect(railBox.width).toBe(TAP_FLOOR_PX);
    expect(dot.width).toBeLessThan(20);

    // The digits went INSIDE the 44px — the hit area did not grow an inch to fit
    // them — and they sit inboard of the dot column, which is the geometry that makes
    // a label-on-dot collision impossible rather than merely unlikely.
    const [label] = await settledBoxes([
      page.getByTestId(`timeline-scrubber-year-${LAST_YEAR}`),
    ]);
    expect(label.x).toBeGreaterThanOrEqual(railBox.x);
    expect(label.x + label.width).toBeLessThanOrEqual(
      railBox.x + railBox.width
    );
    expect(label.x + label.width).toBeLessThanOrEqual(dot.x);

    // …and the feed gives up exactly that column, so the invisible strip is never
    // parked on top of a card's own links. This is the claim that makes a 44px
    // target safe at all.
    const [card] = await settledBoxes([
      page.getByTestId(`history-fold-${MID_MONTH}`),
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
    // A SHORT VIEWPORT, AND THE PREMISE ASSERTED. The drag positions a DOCUMENT
    // scroll offset, so the document has to have one — and the record is compact
    // enough that this fixture's feed (one recent row plus fold cards) fits a full
    // -height window, where `/timeline` filled it with a header, a subtitle, a filter
    // block and a range card that #3958 all removed. Shrinking the window is the
    // honest way to give the gesture something to move; asserting the premise is what
    // stops this passing silently on a page that cannot scroll at all, which is
    // exactly how it failed when the record's feed first replaced the timeline's.
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(FEED);
    const before = page.url();
    const month = page.getByTestId(`history-fold-${OLDEST_MONTH}`);
    await expect(month).toHaveAttribute("data-fold-open", "false");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      ),
      "the feed must be scrollable or the drag asserts nothing"
    ).toBeGreaterThan(0);

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
      page.getByTestId(`history-fold-${MID_MONTH}-toggle`)
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
    // The year's digits move to whichever stop now leads that year — the label rides
    // the year MARK, and opening the year moved the mark onto its newest month.
    await railReady(page);
    await expect(
      page.getByTestId(`timeline-scrubber-year-${LAST_YEAR}`)
    ).toBeVisible();
  });
});

test.describe("the record's jump rail under reduced motion (#2657 item 4)", () => {
  // The harness builds its own contexts (DB-per-worker), so the preference rides in
  // through `contextOptions` rather than the bare `reducedMotion` test option — the
  // same shape as the suite's other reduced-motion contexts.
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

// THE RAIL OVERLAPS THREE SURFACES, AND EACH RESERVES ITS INTRUSION (#3403).
//
// The invariant the rail's own comment states — it sits above everything in that
// column, which is only safe because what it overlaps gives up a gutter — was written
// for TWO surfaces and there are three. The page header was the one nobody counted,
// and it is the one carrying a primary link ("Year in review"), whose right ~28px
// therefore returned the RAIL to `elementFromPoint`: a tap there dragged the scrubber.
//
// The gutter is also the rail's INTRUSION, not the rail's width. The strip is fixed to
// the VIEWPORT, so the content column's own 16px right margin already stands between
// the two: 44 − 16 = 28. Reserving 44 counted the page margin twice and left a 16px
// band down the right of the whole feed reserved for nothing, which is what the owner
// saw as "a gap on the right".
//
// Measured at the owner's own 430×932, since the numbers in #3403 are that width's.
test.describe("the rail's column on a phone (#3403)", () => {
  test.use({ viewport: { width: 430, height: 932 } });
  test.beforeAll(seed);
  test.afterAll(cleanup);

  // A surface's CONTENT right edge: its border box minus the gutter it reserves.
  // Comparing padded boxes would say every surface agrees while their contents do
  // not, which is the exact shape of the bug.
  async function contentRight(page: Page, selector: string): Promise<number> {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      return r.right - parseFloat(getComputedStyle(el).paddingRight);
    }, selector);
  }

  // THE HEADER-ACTION TEST IS GONE WITH ITS SUBJECT. `/timeline`'s header carried a
  // "Year in review" link, and #3403's finding was that the rail sat on top of its
  // right edge — `elementFromPoint` returning the strip while the link looked fine.
  // The record's header carries no action at all (the ≤140px chrome budget is why),
  // so there is nothing at that corner to be covered. The rail-vs-content half of
  // #3403 is still asserted below and in e2e/history.spec.ts.

  test("header, controls and feed share one right edge, and it is the rail's left one", async ({
    page,
  }) => {
    await page.goto(FEED);
    await expect(page.getByTestId("history-filters")).toBeVisible();
    const rail = strip(page);
    await railReady(page);
    const [railBox] = await settledBoxes([rail]);

    // The rail is flush to the viewport at its 44px hit width: 386→430 at 430px.
    expect(railBox.width).toBe(TAP_FLOOR_PX);

    const edges = {
      controls: await contentRight(page, '[data-testid="history-filters"]'),
      row: await contentRight(page, '[data-testid="history-row-content"]'),
    };
    // The reserved band equals the intrusion with NOTHING left over: both surfaces
    // stop exactly where the rail begins. The feed used to stop 16px short.
    expect(edges.controls).toBeCloseTo(railBox.x, 0);
    expect(edges.row).toBeCloseTo(railBox.x, 0);

    // AND THE BAND ITSELF STILL REACHES THE EDGE — the converse, without which the
    // assertion above is satisfied by simply shrinking the whole row. #3920 rules the
    // fill FULL-BLEED below `sm` with the CONTENT inset, which is two different
    // elements at two different right edges; a day card reserves nothing here on
    // purpose (`sm:pr-7`), so measuring the gutter on it would assert the opposite of
    // the rule. Measured as a relationship between the two boxes, not against a
    // constant.
    const band = await page
      .getByTestId("history-row")
      .first() // first-ok: the rule is per-row and identical on every one
      .evaluate((el) => el.getBoundingClientRect().right);
    expect(band).toBeGreaterThan(edges.row);
    expect(band).toBeCloseTo(430, 0);

    // Nothing bought that by pushing a box past the edge, at either phone width.
    // Element-level and not a document-width comparison: the app shell clips
    // horizontal overflow, so a document check is unconditionally true here and
    // asserts nothing (#1543).
    for (const width of [430, 390]) {
      await page.setViewportSize({ width, height: 932 });
      await expect(page.getByTestId("history-filters")).toBeVisible();
      await expectNoClippedContent(page);
    }
  });

  test("a feed with no rail reserves nothing", async ({ page }) => {
    // The gutter is gated on the rail existing, and stays gated. A single-day view
    // has one period, which is below SCRUBBER_MIN_TICKS, so no rail renders — and
    // the surfaces underneath must then use the full column rather than carrying an
    // empty 28px band for a strip that is not there.
    await page.goto(`/history?kind=goal&day=${DATES.mid}`);
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(strip(page)).toHaveCount(0);
    // The feed itself rendered — a day that fell through to the empty state would
    // make the padding read 0px for a reason this test is not asserting.
    await expect(page.getByTestId("history-day")).toBeVisible();

    for (const selector of [
      '[data-testid="history-filters"]',
      '[data-testid="history-day"]',
    ]) {
      expect(
        await page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)!).paddingRight,
          selector
        ),
        selector
      ).toBe("0px");
    }
  });
});
