import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  appContent,
  expectSvgTextLegible,
  followLink,
  hydratedClick,
  settledBoxes,
  settledClick,
  settledPickOption,
  settledSelect,
} from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TL_CHROME,
  TL_CHROME_SICK_PROFILE,
  TL_CHROME_WELL_PROFILE,
  TL_CHROME_BUSY_DAY,
  TL_CHROME_QUIET_DAY,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The record day view's phone chrome (issue #1517), inherited from `/timeline` when
// #3958 phase 2 retired that route and `/history?day=` became the app's one "that
// day" anchor.
//
// ONE of #1517's three fixes still has a subject here — A, the sticky/scroll
// priority: the day nav (used constantly) takes the pinned slot and rides the shell
// chrome, while the filter row scrolls away.
//
// Fix B (collapsing the filter block) does not: the record has one filter row and no
// range chrome, so there is nothing to collapse. The note where its test stood says
// what asserts the budget instead.
//
// Fix C — the symptom logger folded behind "+ Log symptom" — has no subject either,
// because #4851 retired the card it folded. The day view's symptom entry is the Add
// past row's door now, like every other log kind's, and the test below is what
// replaced C's: the chip, the door on the day being read, and the absence of the
// card at both widths.
//
// Fixture (#868): a dedicated login over two dedicated profiles — see
// e2e/logins/history.ts. Deep-past days. Two tests here WRITE — the door's, and the
// ⋯ correction's — each on its own symptom key on the quiet day, cleared either side
// of itself, so the file stays repeat-safe under --repeat-each.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

function dayUrl(date: string): string {
  return `/history?day=${date}`;
}

// The sick profile's id, so the spec can switch the session's active profile to it
// through the product's own affordance.
function sickProfileId(): number {
  return profileIdNamed(TL_CHROME_SICK_PROFILE);
}

function profileIdNamed(name: string): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db.prepare("SELECT id FROM profiles WHERE name = ?").get(name) as {
        id: number;
      }
    ).id;
  } finally {
    db.close();
  }
}

// The symptom the add door writes, and the ONE thing this file mutates. Not `cough`
// or `headache` — those are the seeded symptom day's, and a fixture that shared a key
// with the seed could not tell its own write apart from the seed's.
const DOOR_SYMPTOM = "sneezing";
const DOOR_LABEL = "Sneezing";

// EVERY DAY the well profile carries this symptom on, which is the shape the "posts
// to the day being read, never today" assertion needs: a door that defaulted to today
// produces `[<today>]` here, and one that lost the day entirely produces `[]`. Asking
// only "is there a row on the day I read" could not tell those apart.
function doorSymptomDates(): string[] {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return (
      db
        .prepare(
          "SELECT date FROM symptom_logs WHERE profile_id = ? AND symptom = ? ORDER BY date"
        )
        .all(profileIdNamed(TL_CHROME_WELL_PROFILE), DOOR_SYMPTOM) as {
        date: string;
      }[]
    ).map((row) => row.date);
  } finally {
    db.close();
  }
}

// Start (and leave) from ABSENCE. Without this the second viewport's pass — and every
// --repeat-each iteration after the first — would find the row already there and go
// green on the previous run's write.
function clearDoorSymptom(): void {
  clearWellSymptom(DOOR_SYMPTOM);
}

// The correction test's own key, distinct from the door's and from the seed's two, so
// neither writing test in this file can read the other's row.
const CORRECT_SYMPTOM = "chills";
const CORRECT_LABEL = "Chills";

function clearWellSymptom(symptom: string): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM symptom_logs WHERE profile_id = ? AND symptom = ?"
    ).run(profileIdNamed(TL_CHROME_WELL_PROFILE), symptom);
  } finally {
    db.close();
  }
}

// The row the correction is driven against, planted directly: this test is about the
// ⋯, not about the door that would otherwise have written it.
function seedCorrectSymptom(severity: number): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity, note)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(
      profileIdNamed(TL_CHROME_WELL_PROFILE),
      TL_CHROME_QUIET_DAY,
      CORRECT_SYMPTOM,
      severity
    );
  } finally {
    db.close();
  }
}

function correctSymptomSeverity(): number | null {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare(
        "SELECT severity FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = ?"
      )
      .get(
        profileIdNamed(TL_CHROME_WELL_PROFILE),
        TL_CHROME_QUIET_DAY,
        CORRECT_SYMPTOM
      ) as { severity: number } | undefined;
    return row?.severity ?? null;
  } finally {
    db.close();
  }
}

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(
    browser,
    { username: E2E_LOGIN_TL_CHROME, password: E2E_MEMBER_PASSWORD },
    { viewport: PHONE, hasTouch: true }
  );
}

// The shell chrome's scroll listener only exists after hydration (see
// components/useShellChrome.ts), and the day nav rides the same machine — so every
// scroll assertion waits for the listener to be attached rather than racing it.
async function chromeReady(page: Page): Promise<void> {
  await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
    "data-ready",
    "true"
  );
  await expect(page.getByTestId("timeline-day-nav")).toHaveAttribute(
    "data-ready",
    "true"
  );
}

async function scrollTo(page: Page, y: number): Promise<number> {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  return page.evaluate(() => window.scrollY);
}

test.describe("the record day view's phone chrome (#1517, inherited)", () => {
  test("the day nav takes the pinned slot and the filter row scrolls away (A)", async ({
    browser,
  }) => {
    test.slow(); // the record is one of the app's heaviest server renders
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      await chromeReady(page);

      const nav = page.getByTestId("timeline-day-nav");
      const filters = page.getByTestId("history-filters");
      await expect(nav).toBeVisible();

      // It is genuinely sticky on a phone — the premise of the swap.
      await expect
        .poll(() => nav.evaluate((el) => getComputedStyle(el).position))
        .toBe("sticky");
      // …and the filter row is NOT. On `/timeline` the block was the pinned one.
      await expect
        .poll(() => filters.evaluate((el) => getComputedStyle(el).position))
        .toBe("static");

      // Scroll deep into the day's events. The nav rides the shell chrome, so it
      // travels away with the top bar on the way DOWN (the #1485 F contract) …
      //
      // MEASURED AGAINST THE PAGE, NOT AGAINST A CONSTANT. This scrolled to a flat
      // 1200 and required 400 to remain after backing off 300 — numbers taken from
      // `/timeline`, whose two-line event CARDS made the busy day roughly twice as
      // tall as the record's one-line rows. Measured here at 390px, the same day is
      // ~700px of scroll, so the old floor failed on a page that behaves correctly.
      // The claim was never about a pixel count: it is that an upward scroll brings
      // the nav back while the reader is STILL in the day's events rather than back
      // at its top. So the floor is the day's own scrollable height.
      const maxScroll = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      expect(
        maxScroll,
        "the busy day should be scrollable at phone width"
      ).toBeGreaterThan(300);
      const deep = await scrollTo(page, maxScroll);
      await expect(nav).toHaveAttribute("data-hidden", "true");

      // … and comes straight back on any upward scroll, STILL deep in the page —
      // which is the whole fix: prev/next day is reachable mid-day, where before it
      // had scrolled off with the events. A THIRD of the way back up, so the reveal
      // is asserted somewhere that is unambiguously not the top.
      const stillDeep = await scrollTo(page, Math.round(deep * 0.66));
      expect(stillDeep).toBeGreaterThan(deep / 3);
      await expect(nav).toHaveAttribute("data-hidden", "false");
      // ONE SETTLED SNAPSHOT, not two raw reads (#2437's family; measured here on
      // #3079's CI shard). `data-hidden` flips at the START of the chrome's
      // reveal, not the end, so a `boundingBox()` taken the instant the attribute
      // asserts catches the day nav MID-SLIDE. Measured on an idle box across five
      // trials, the immediate read was 57, 49.96, 51.61, 51.57 and 14.86 while the
      // SETTLED read was 57 every time; on a contended CI worker the same race
      // reported -12.54 and failed the budget below.
      //
      // The budget itself is untouched — widening -2 to swallow -12.54 would
      // retire the guarantee this case exists to hold ("pinned in the top band").
      // What changed is that the number being judged now comes from a layout that
      // actually held still. settledBoxes measures both elements in the same
      // settled snapshot, which is also what makes the two assertions below
      // describe ONE layout rather than two.
      const [navBox, filterBox] = await settledBoxes([nav, filters]);
      // -2 epsilon: sticky positioning can report a sub-pixel negative y
      // (-0.82 observed) while visually pinned at the top — the assertion is
      // "pinned in the top band", not "mathematically at 0".
      expect(navBox.y).toBeGreaterThan(-2);
      expect(navBox.y).toBeLessThan(160);
      await expect(page.getByTestId("timeline-day-prev")).toBeVisible();

      // The filter row, meanwhile, has scrolled off the top entirely.
      expect(filterBox.y + filterBox.height).toBeLessThan(0);
    } finally {
      await page.context().close();
    }
  });

  // THE TWO STRIPS NO LONGER SHARE A PAGE (#4918 ruling 1), and #4558's claim is
  // unchanged for both. The day view's per-group header retired — its date was
  // printed below the chart as a link to the page already open, and the day bar
  // names the day instead — so the day view now has ONE sticky strip and the sticky
  // day header is the FEED's, which #4918 leaves exactly as it was. Each is measured
  // on the page that still draws it, through the same helper and the same forged
  // inset, rather than the day header being retargeted at the bar (which would have
  // made both halves of a two-strip test read the same element).
  test("both sticky strips park below a forged top inset (#4558)", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      const nav = page.getByTestId("timeline-day-nav");
      const day = page.locator('[data-testid="history-day"] h2');
      const flow = page.getByTestId("history-filters");
      const NOTCH = 37;

      // A sticky-looking position at rest proves nothing: <main>'s safe-area padding
      // moves ordinary flow too. Hold the target still across a real scroll while the
      // static filter moves by the inverse delta, then compare the two inset states.
      const parkedY = async (
        target: typeof nav,
        from: number,
        to: number
      ): Promise<number> => {
        const firstScroll = await scrollTo(page, from);
        const [first, firstFlow] = await settledBoxes([target, flow]);
        const secondScroll = await scrollTo(page, to);
        const [second, secondFlow] = await settledBoxes([target, flow]);
        const moved = secondScroll - firstScroll;
        expect(Math.abs(moved), "the page really scrolled").toBeGreaterThan(30);
        expect(
          Math.abs(second.y - first.y),
          "the strip stays parked"
        ).toBeLessThan(2);
        expect(
          Math.abs(secondFlow.y - firstFlow.y + moved),
          "an in-flow row travels one-for-one with the scroll"
        ).toBeLessThan(2);
        return second.y;
      };

      // The forged inset is a style on the document, so it is re-applied after every
      // navigation rather than once per pass.
      const forge = async (inset: number) =>
        page.evaluate(
          (px) =>
            document.documentElement.style.setProperty(
              "--top-edge-inset",
              `${px}px`
            ),
          inset
        );
      const bottom = () =>
        page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight
        );

      const measure = async (inset: number) => {
        await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
        await chromeReady(page);
        await forge(inset);
        await scrollTo(page, 0);
        await expect(nav).toHaveAttribute("data-hidden", "false");
        const deep = await scrollTo(page, await bottom());
        await expect(nav).toHaveAttribute("data-hidden", "true");
        const navFrom = deep - 100;
        await scrollTo(page, navFrom);
        await expect(nav).toHaveAttribute("data-hidden", "false");
        const navY = await parkedY(nav, navFrom, navFrom - 48);

        await page.goto("/history");
        await expect(page.getByTestId("shell-chrome")).toHaveAttribute(
          "data-ready",
          "true"
        );
        await forge(inset);
        await scrollTo(page, 0);
        const [dayAtRest] = await settledBoxes([day.first()]); // first-ok: the feed's topmost day group is the one scrolled past
        const maxScroll = await bottom();
        const dayFrom = Math.round(dayAtRest.y + 40);
        expect(
          maxScroll - dayFrom,
          "the feed has a sticky window"
        ).toBeGreaterThan(100);
        await scrollTo(page, dayFrom);
        const dayY = await parkedY(day.first(), dayFrom, dayFrom + 48); // first-ok: same group as above
        return { dayY, navY };
      };

      const ordinary = await measure(0);
      const forged = await measure(NOTCH);
      expect.soft(Math.round(forged.dayY - ordinary.dayY)).toBe(NOTCH);
      expect.soft(Math.round(forged.navY - ordinary.navY)).toBe(NOTCH);
    } finally {
      await page.context().close();
    }
  });

  // FIX B HAS NO SUBJECT HERE, AND THAT IS THE POINT. `/timeline` met its chrome
  // budget by COLLAPSING a filter block that carried a category row, a date-range
  // card and a quick-range row. The record meets the same budget by not having them:
  // #3958 rules ONE filter row and NO range chrome at all, so there is no block to
  // collapse and no summary line to expand. Deleting the test rather than porting it
  // is the honest reading — a collapse guard over a surface with nothing to collapse
  // would be green for the wrong reason. The budget itself is asserted directly, in
  // e2e/history.spec.ts ("spends no more than the chrome budget above its first
  // record at 390px").

  // #4851 — THE DAY VIEW'S SYMPTOM ENTRY IS THE ADD PAST ROW'S DOOR, and the
  // standalone card that used to sit below the chart is gone. This replaces #1517 C's
  // fold test: the fold's subject was a second entry surface the day view no longer
  // has, so porting that test would have asserted a collapse over nothing.
  //
  // BOTH WIDTHS, because the Add past row is the thing that changed shape: it scrolls
  // horizontally at 390 and wraps from `sm` up, so the chip has to be reachable in a
  // scroller as well as in a wrapped row.
  test("symptoms is an Add past chip, and its door writes on the day being read", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      for (const viewport of [DESKTOP, PHONE]) {
        clearDoorSymptom();
        expect(doorSymptomDates(), `${viewport.width}: starts absent`).toEqual(
          []
        );
        await page.setViewportSize(viewport);
        await page.goto(dayUrl(TL_CHROME_QUIET_DAY));

        // THE RETIRED CARD, asserted where it stood.
        await expect(page.getByTestId("history-symptom-entry")).toHaveCount(0);
        await expect(page.getByTestId("history-symptom-toggle")).toHaveCount(0);

        // THE CHIP, in the row with its siblings rather than on a line of its own.
        const chip = page.getByTestId("history-add-symptom");
        await expect(chip).toHaveText("Symptoms");
        await followLink(page, chip, /kind=symptom/);
        // The day rode across the chip: the door can only be about the day being read
        // if the navigation kept it.
        expect(new URL(page.url()).searchParams.get("day")).toBe(
          TL_CHROME_QUIET_DAY
        );

        await hydratedClick(page, page.getByTestId("history-add-open-symptom"));
        const panel = page.getByTestId("history-add-panel-symptom");
        await expect(panel).toBeVisible();
        await settledPickOption(
          page,
          panel.getByRole("combobox", { name: "Symptom" }),
          DOOR_LABEL
        );
        await settledClick(page, panel.getByTestId("symptom-form-save"));

        // THE ASSERTION THIS TEST EXISTS FOR, asked of the store and asked FIRST, so a
        // door that posted today fails here by NAMING the day it used rather than as a
        // missing row two lines down. `settledClick` returned on the action's own
        // response, so the row is committed. The whole date set is compared: a door
        // that lost the day gives `[]`, one that defaulted to today gives `[<today>]`,
        // and a stray second row cannot hide behind a matching first one.
        expect(
          doorSymptomDates(),
          `${viewport.width}: the door posted the day being read`
        ).toEqual([TL_CHROME_QUIET_DAY]);
        // And the day's own feed shows it, which is the reader's half of the same claim.
        await expect(
          page.getByTestId("history-row-title").filter({ hasText: DOOR_LABEL })
        ).toHaveCount(1);

        // THE CONVERSE, through the product: a future `?day=` clamps to today
        // (`clampHistoryDay`), so this is today's own day view — and the symptom just
        // written is not on it.
        await page.goto("/history?day=2099-01-01&kind=symptom");
        await expect(
          page.getByTestId("history-row-title").filter({ hasText: DOOR_LABEL })
        ).toHaveCount(0);
      }
    } finally {
      clearDoorSymptom();
      await page.context().close();
    }
  });

  // #4851 item 3 — THE SICK-DAY AUTO-OPEN GOES. The second entry surface used to
  // arrive already open on an ordinary quiet day whenever an illness-type situation
  // was active; the illness cockpit is the sick-day surface, and the record does not
  // need a second one. The sick profile is the only fixture that can say so, because
  // the branch was per-profile.
  test("an active illness situation opens no symptom card on the day view", async ({
    browser,
  }) => {
    test.slow();
    const sickId = sickProfileId();
    const page = await signIn(browser);
    try {
      // The switch is driven at DESKTOP width on purpose: below `md` the profile menu
      // lives inside the nav drawer, and the (hidden) desktop sidebar renders the same
      // markup at every viewport, so an unscoped trigger is two elements.
      await page.setViewportSize(DESKTOP);
      await page.goto("/history");
      const trigger = page.getByTestId("profile-identity-bar");
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
      await settledClick(page, page.getByTestId(`switch-to-${sickId}`));
      // Settle on the server-rendered result of the switch before navigating — a
      // goto over an in-flight action loses the write (#1437).
      await expect(trigger).toContainText(TL_CHROME_SICK_PROFILE);

      for (const viewport of [DESKTOP, PHONE]) {
        await page.setViewportSize(viewport);
        await page.goto(dayUrl(TL_CHROME_QUIET_DAY));
        // The day view rendered — without this the two absences below are satisfied by
        // a page that failed to load at all.
        await expect(page.getByTestId("timeline-day-nav")).toBeVisible();
        await expect(page.getByTestId("history-symptom-entry")).toHaveCount(0);
        await expect(page.getByTestId("symptom-log-bar")).toHaveCount(0);
      }
    } finally {
      await page.context().close();
    }
  });

  // THE OTHER HALF OF #4851: what the retired card TOOK AWAY has to still be there.
  // The bar carried `SymptomRowControl` — the day's taps, note and clear — so until
  // this change the day view had two ways to fix a logged symptom. One is left, the ⋯
  // that #4621 ruling 3 put on the feed row, and #4851's acceptance criterion asks for
  // it by name.
  //
  // IT NAMES AN "EXISTING E2E" AND THERE IS NONE. `history-row-edit` is driven in
  // exactly two specs — e2e/history.spec.ts on a PRACTICE row and
  // e2e/bristol-stool.spec.ts on a stool row — and no spec above the component tier
  // (components/__tests__/symptom-two-pieces.test.tsx) has ever opened a symptom row's
  // menu. So the criterion is asserted here rather than reported as satisfied by a
  // test that does not exist.
  //
  // DOWNWARDS ON PURPOSE. `logSymptom` keeps the day's WORST, so a raise is also what
  // an ordinary re-log produces; only `editSymptom` can lower one, and lowering is the
  // correction the retired bar's labelled chips used to be the way to make.
  test("the day's symptom row still corrects through the row menu", async ({
    browser,
  }) => {
    test.slow();
    clearWellSymptom(CORRECT_SYMPTOM);
    seedCorrectSymptom(3);
    const page = await signIn(browser);
    try {
      await page.setViewportSize(DESKTOP);
      await page.goto(dayUrl(TL_CHROME_QUIET_DAY));
      const row = () =>
        page.getByTestId("history-row").filter({ hasText: CORRECT_LABEL });
      await expect(row().getByTestId("history-row-detail")).toContainText(
        "Severe"
      );

      await hydratedClick(page, row().getByTestId("overflow-menu-trigger"));
      await page.getByTestId("history-row-edit").click();
      const form = page.getByTestId("history-row-editing");
      // The symptom is half the row's ADDRESS, so the edit mount hands the form one
      // choice and the picker collapses — there is no combobox to pick in here.
      await expect(form.getByTestId("symptom-form-picker")).toHaveCount(0);
      await settledSelect(page, form.getByTestId("symptom-form-severity"), "1");
      await settledClick(page, form.getByTestId("symptom-form-save"));

      // The STORE first, on the day being corrected: `symptom_logs` is
      // UNIQUE(profile_id, date, symptom), so a correction that reached for today
      // would leave this row at 3 and fork a second one.
      await expect.poll(() => correctSymptomSeverity()).toBe(1);
      // And the row repaints in place, which is the page's own promise (#4062).
      await expect(row().getByTestId("history-row-detail")).toContainText(
        "Mild"
      );
      await expect(row().getByTestId("history-row-detail")).not.toContainText(
        "Severe"
      );
    } finally {
      clearWellSymptom(CORRECT_SYMPTOM);
      await page.context().close();
    }
  });

  test("desktop is unchanged: the day nav stops sticking, and nothing collapses", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      await page.setViewportSize(DESKTOP);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

      // The day nav drops to static from `sm` up — the pinned slot is a phone
      // affordance, bought because viewport height is scarce there and not here.
      await expect
        .poll(() =>
          page
            .getByTestId("timeline-day-nav")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("static");

      // AND THE FILTER ROW IS STATIC AT BOTH WIDTHS, which is the half that changed:
      // `/timeline` made its filter block sticky from `md` up. The record's row is
      // one line, so pinning it would spend the budget it exists to protect. Asserted
      // beside the nav rather than alone — "nothing is sticky" passes on a page that
      // rendered no chrome at all, and the nav assertion above is what rules that out.
      await expect
        .poll(() =>
          page
            .getByTestId("history-filters")
            .evaluate((el) => getComputedStyle(el).position)
        )
        .toBe("static");
    } finally {
      await page.context().close();
    }
  });
});

// THE SUBTITLE TEST WENT WITH THE ROUTE (#3452 item 3). It guarded
// `hideSubtitleBelowSm` against a silent revert, and `/timeline`'s subtitle — the
// longest in the app — was the only thing in the tree that passed the prop. The
// record uses `compactBelowSm` instead and states its own rule in #3958 ("no
// h1/subtitle below `sm`"), which e2e/history.spec.ts's chrome-budget case measures
// directly rather than by naming a prop. The prop itself now has no call site; that
// is recorded on the PR as an open question rather than removed here.

// THE DAY VIEW'S SECOND COLUMN (#4974). On a wide screen the reading column left
// half the viewport empty while the day's map sat capped inside it, so above the
// threshold the rows keep the reading measure and a sticky rail beside them holds
// the chart, the add layer and the month calendar — open there, because the grid is
// no longer above the first record and spends none of the chrome budget.
//
// THE TESTABLE HALF IS "BELOW THE THRESHOLD NOTHING CHANGES", and it gets its own
// test at three widths. A grid introduced at one breakpoint is easy to get right
// there and wrong just under it, and every assertion below is a RELATIONSHIP between
// two real elements — the rail against the rows — because "the rail is present" is
// satisfied by a rail stacked above them in source order, which is exactly the
// stacked layout this must not disturb.
//
// 1409 IS THE THRESHOLD AND IT IS MEASURED, NOT CHOSEN — the derivation lives beside
// `dayGrid` in app/(app)/history/page.tsx. The shell spends 240px on the sidebar and
// 40px on the page gutters, the grid 768 + 24 on the reading column and the gap, and
// the chart's card a further 42px of padding, so the DRAWING gets `viewport - 1114`.
// Since #4973 the chart picks its geometry from THAT box, so the binding floor is
// the compact one — `11 × container ÷ 360` against #1518's 9px minimum, which needs
// 294.55px. Swept in this browser at this head:
//
//     viewport 1280 → container 166 → 5.07px     viewport 1409 → 295 → 9.01px
//     viewport 1400 → container 286 → 8.74px     viewport 1440 → 326 → 9.96px
//
// So 1409 is the first width that pays, and #4974's 1440 acceptance criterion holds
// as written. BOTH are tested below, and 1409 is in the table for a reason: its
// headroom over the floor is 0.014px, so one pixel added to the gap, the gutters or
// the card's padding reds this file instead of shipping 8.99px type.
//
// AND THE RAIL'S CHART IS THE *COMPACT* GEOMETRY, which is the premise #4974 got
// wrong ("the rail simply gives it 760px" — at 1440 it gives 326). Since #4973 that
// is a container query the chart answers for itself, and asserting the variant here
// is what would catch the rail silently handing it a box in the dead band.
//
// THE HEIGHT IS 640 AND IT IS LOAD-BEARING, not the project default. The day view's
// rows are one line each and the chart has moved off the reading column, so at 900
// the busy day scrolls less than the chart's own offset, and an UNPINNED rail would
// still be on screen at the bottom of the page — the sticky assertion would pass
// against a rail with no `sticky` on it at all. The test asserts that condition
// rather than trusting this number.
//
// THE THRESHOLD ITSELF AND THE ACCEPTANCE CRITERION'S WIDTH, in one table: the first
// is where the arithmetic is tightest and the second is the width the issue rules.
const RAIL_WIDTHS = [
  { label: "the threshold", width: 1409, height: 640 },
  { label: "#4974's 1440", width: 1440, height: 640 },
];
const RAIL = RAIL_WIDTHS[1]; // first-ok analogue: the AC's own width, for the single-width tests
// One pixel under the threshold: the width where the stack must still be a stack.
const BELOW_RAIL = { width: 1408, height: 900 };
// The width #4974's acceptance criteria name for the STACK, and the phone.
const LAPTOP = { width: 1024, height: 900 };
// Wide enough for the rail, too short to hold it: the state the height cap exists
// for, and the test below proves the fixture reaches it rather than assuming so.
const RAIL_SHORT = { width: 1440, height: 420 };
// The drawing the rail's box earns (#4973). The rail is 368px at 1440 and the chart
// card 326px of that, well under `INTRADAY_VARIANTS.wide.minContainerPx` — so the
// chart in the rail is the compact geometry at every width this file drives.
const RAIL_DRAWING = '[data-variant="compact"]';

test.describe("the day view's rail beside its reading column (#4974)", () => {
  // BOTH RAIL WIDTHS RUN THE WHOLE ARRANGEMENT. They differ only in viewport, so
  // they are a table rather than two tests: the threshold is where the label floor
  // is tightest and 1440 is the width the issue rules.
  for (const viewport of RAIL_WIDTHS) {
    test(`at ${viewport.width} (${viewport.label}) the rows sit beside a sticky rail holding chart, add layer and calendar`, async ({
      browser,
    }) => {
      test.slow();
      const page = await signIn(browser);
      const app = appContent(page);
      try {
        await page.setViewportSize(viewport);
        await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

        const rail = app.getByTestId("history-day-rail");
        const feed = app.getByTestId("history-feed");
        const panel = rail.getByTestId("intraday-panel");
        // WAIT FOR THE CONTENT, NOT THE CONTAINER. Every measurement below is about
        // where two boxes sit relative to each other, and an empty column fits beside
        // anything — so the chart and the first row are awaited before anything is
        // read.
        await expect(panel).toBeVisible();
        const firstRow = feed.getByTestId("history-row").first(); // first-ok: any row will do; the claim is about the column that holds them
        await expect(firstRow).toBeVisible();

        const [railBox, feedBox] = await settledBoxes([rail, feed]);
        // BESIDE, AND THE MEASUREMENT SAYS SO. Two full-width blocks in source order
        // satisfy "the rail exists" and "the rail is 760px or less" without ever
        // sitting beside anything, so the claim is the horizontal gap AND the vertical
        // overlap: the rail starts after the column ends, and the two share rows.
        expect(
          railBox.x,
          `the rail starts at ${railBox.x}, the column ends at ${
            feedBox.x + feedBox.width
          }`
        ).toBeGreaterThanOrEqual(feedBox.x + feedBox.width);
        expect(railBox.y).toBeLessThan(feedBox.y + feedBox.height);
        expect(feedBox.y).toBeLessThan(railBox.y + railBox.height);
        // AND THE COLUMN KEEPS THE READING MEASURE — the invariant the arrangement is
        // bounded by. `max-w-3xl` is 48rem, and two flexible tracks would have split
        // the space evenly and called the result a reading column.
        expect(Math.round(feedBox.width), "the rows keep 48rem").toBe(768);
        // AND THE CHART IN IT IS LEGIBLE, which is what fixes the threshold at 1409.
        // The rail is the narrowest container the day chart is ever drawn into, and
        // the geometry scales its type by `container ÷ viewBox` — so a rail opened one
        // tier earlier paints 5.07px labels (measured at `xl`) and reds
        // e2e/intraday-panel.spec.ts. Measured here rather than derived, because the
        // arithmetic is what was wrong about `xl` in the first place, and measured AT
        // the threshold because that is where it is tightest: 9.01px against 9.
        await expectSvgTextLegible(page);
        // AND IT IS THE COMPACT DRAWING. #4974 assumed the rail hands the chart 760px;
        // it hands it 326 at 1440, and since #4973 the chart answers that for itself.
        // If a future rail widened into the 420-520 dead band this is the assertion
        // that would say so, rather than the labels quietly changing size.
        await expect(panel.locator(RAIL_DRAWING)).toBeVisible();

        // WHAT THE RAIL HOLDS, TOP TO BOTTOM, asserted as order rather than presence.
        const add = rail.getByTestId("history-add");
        const calendar = rail.getByTestId("history-calendar-open");
        await expect(add).toBeVisible();
        await expect(calendar).toBeVisible();
        const [panelBox, addBox, calBox] = await settledBoxes([
          panel,
          add,
          calendar,
        ]);
        expect(panelBox.y).toBeLessThan(addBox.y);
        expect(addBox.y).toBeLessThan(calBox.y);
        // The door disappears at this width and nowhere else — the grid it opens is
        // already on screen, so a second way to it is a second copy.
        await expect(app.getByTestId("history-calendar")).toBeHidden();

        // THE SCROLL, which is the whole point of the rail: reading the rows must not
        // take the map off screen. Asserted as the two boxes moving DIFFERENTLY —
        // the rows travel with the page, the panel does not.
        const rowBefore = (await firstRow.boundingBox())!;
        const maxScroll = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight
        );
        const scrolled = await scrollTo(page, maxScroll);
        // THE FIXTURE HAS TO REACH THE STATE THIS FORBIDS. Scrolling less than the
        // chart's own starting offset leaves an unpinned chart on screen too, and the
        // assertion below would be green against a rail that never stuck.
        expect(
          scrolled,
          `the page scrolls ${scrolled}px and the chart starts ${panelBox.y}px down — ` +
            "the scroll must pass it, or an unpinned rail would still be in view"
        ).toBeGreaterThan(panelBox.y);
        const rowAfter = (await firstRow.boundingBox())!;
        expect(
          rowBefore.y - rowAfter.y,
          "the rows travelled with the scroll"
        ).toBeGreaterThan(scrolled - 2);
        const panelAfter = (await panel.boundingBox())!;
        // FULLY in view, top and bottom: an unpinned rail would be carried ~600px up
        // and its top edge would be negative.
        expect(
          panelAfter.y,
          `the chart's top sits at ${panelAfter.y} after a ${scrolled}px scroll`
        ).toBeGreaterThanOrEqual(0);
        expect(panelAfter.y + panelAfter.height).toBeLessThanOrEqual(
          viewport.height
        );
      } finally {
        await page.context().close();
      }
    });
  }

  // THE TICK TAP, which is what the rail is FOR (#1515: chart as map, list as
  // detail). On one column the tap took the reader to the row and carried the map
  // off screen on the way, so the jump cost you the thing that named it.
  //
  // THE FIXTURE HAD TO GROW A MARK for this. The busy day's twenty sessions are
  // day-granular and draw no ticks at all, so the fixture gained ONE clock-timed
  // document (TL_CHROME_TICK_DOC, 20:30) — and it had to be THIS day rather than
  // #1068's already-marked one, whose six rows leave its rail taller than the
  // column beside it, with nowhere to stick and nothing to prove.
  test("a tick tap moves the rows and leaves the chart where it is", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    const app = appContent(page);
    try {
      await page.setViewportSize(RAIL);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

      const rail = app.getByTestId("history-day-rail");
      const panel = rail.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();
      // Scoped to the drawing the rail's own box earns (#4973): the panel renders
      // both geometries and a container query hides one, so an unscoped tick locator
      // matches each mark twice and half the matches are in the copy `display: none`
      // is holding.
      const chart = panel.locator(RAIL_DRAWING);
      await expect(chart).toBeVisible();
      const firstRow = app
        .getByTestId("history-feed")
        .getByTestId("history-row")
        .first(); // first-ok: spec-owned fixture, and the claim is the column rather than a particular row
      await expect(firstRow).toBeVisible();

      // THE TICK WHOSE ENTRY SITS FURTHEST DOWN. A tick whose row is already on
      // screen scrolls nothing, and "the chart did not move" is then trivially true
      // of a page that never moved either — so the target is CHOSEN by measuring.
      const targets = await chart
        .getByTestId("intraday-tick")
        .evaluateAll((nodes) =>
          nodes
            .map((node) => {
              const href = node.getAttribute("href") ?? "";
              const el = href.startsWith("#")
                ? document.getElementById(href.slice(1))
                : null;
              return {
                href,
                top: el ? el.getBoundingClientRect().top + window.scrollY : -1,
              };
            })
            .filter((t) => t.top >= 0)
            .sort((a, b) => b.top - a.top)
        );
      expect(
        targets.length,
        "the chart draws at least one tick whose entry is a row on this page"
      ).toBeGreaterThan(0);
      const deepest = targets[0];

      const [railBefore, rowBefore] = await settledBoxes([rail, firstRow]);
      // The rail's pinned inset, read off the CSS rather than typed in here.
      const stickyTop = await rail.evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).top)
      );
      const sel = `[data-testid="intraday-tick"][href="${deepest.href}"]`;
      const tick = chart.locator(sel).first(); // first-ok: one anchor per tick, and the href was read off this same chart
      await followLink(page, tick, new RegExp(`${deepest.href.slice(1)}$`));

      const scrolled = await page.evaluate(() => window.scrollY);
      // THE FIXTURE HAS TO REACH THE STATE THIS FORBIDS, and the threshold is where
      // a sticky rail STARTS to answer differently from a static one — the moment
      // the page has carried the rail up to its own inset. Short of that the two are
      // the same box in the same place, and everything below would be green against
      // a rail with no `sticky` on it at all.
      expect(
        scrolled,
        `the tick jumped ${scrolled}px; the rail pins once the page passes ` +
          `${railBefore.y - stickyTop}px (top ${railBefore.y}, inset ${stickyTop})`
      ).toBeGreaterThan(railBefore.y - stickyTop);

      // THE ROW ARRIVED, whole.
      await expect(page.locator(deepest.href)).toBeInViewport({ ratio: 1 });
      // AND THE TWO BOXES ANSWERED DIFFERENTLY. The rows travelled the whole jump;
      // the rail travelled less and came to rest ON its inset. A static rail would
      // sit at `railBefore.y - scrolled`, which the guard above puts strictly above
      // the inset — so both of these red the moment the pin comes off.
      const rowAfter = (await firstRow.boundingBox())!;
      expect(
        rowBefore.y - rowAfter.y,
        "the rows travelled with the jump"
      ).toBeGreaterThan(scrolled - 2);
      const railAfter = (await rail.boundingBox())!;
      expect(
        railAfter.y,
        `the rail sits at ${railAfter.y}; unpinned it would be at ${
          railBefore.y - scrolled
        }`
      ).toBeGreaterThan(railBefore.y - scrolled);
      expect(Math.round(railAfter.y)).toBe(Math.round(stickyTop));
      // …and the chart is still whole on screen, which is what the reader gets.
      const panelAfter = (await panel.boundingBox())!;
      expect(panelAfter.y).toBeGreaterThanOrEqual(0);
      expect(panelAfter.y + panelAfter.height).toBeLessThanOrEqual(RAIL.height);
    } finally {
      await page.context().close();
    }
  });

  // THE WHEEL OVER THE CHART IS THE PAGE'S (owner ruling, 2026-09-04). A scroll
  // container that swallows the wheel over the day's map is the defect the ruling
  // exists to prevent, and it is not a feeling — a wheel goes to its nearest
  // SCROLLABLE ANCESTOR, so with the chart inside the rail's overflow box a reader
  // aiming at the largest thing in the rail scrolled the rail, and the chart's own
  // full-day hand-off (#4852) was handed to the rail instead of to the page.
  //
  // THE VIEWPORT IS THE SHORT ONE ON PURPOSE: at 640 the rail does not overflow, so
  // the rail would keep the wheel either way and this would pass against the very
  // arrangement it forbids. The assertion below proves the box CAN scroll first.
  test("a wheel over the chart scrolls the page, not the rail", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    const app = appContent(page);
    try {
      await page.setViewportSize(RAIL_SHORT);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      const rail = app.getByTestId("history-day-rail");
      const scroller = app.getByTestId("history-day-rail-scroll");
      const panel = rail.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();
      // WAIT FOR THE CONTENT, not the box: the wheel target is the drawing.
      const svg = panel.locator(RAIL_DRAWING).getByTestId("intraday-svg");
      await expect(svg).toBeVisible();

      // THE FIXTURE REACHES THE STATE THIS FORBIDS. If the rail's own box cannot
      // scroll at all, "the rail did not scroll" is true of every arrangement.
      const room = await scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight
      );
      expect(
        room,
        `the rail's scrolling box has ${room}px of travel — with none, this test ` +
          "cannot tell a correct rail from one that swallowed the wheel"
      ).toBeGreaterThan(0);

      const box = (await svg.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
      const before = {
        page: await page.evaluate(() => window.scrollY),
        rail: await scroller.evaluate((el) => el.scrollTop),
      };
      await page.mouse.wheel(0, 400);
      // THE PAGE TOOK IT…
      await expect
        .poll(() => page.evaluate(() => window.scrollY))
        .toBeGreaterThan(before.page);
      // …AND THE RAIL DID NOT, which is the half a "feels right" check misses.
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before.rail);
      // AND THE BOX BELOW THE CHART STILL SCROLLS ON ITS OWN — the converse, so this
      // is not green because the rail simply lost its overflow everywhere.
      const railBox = (await scroller.boundingBox())!;
      await page.mouse.move(
        railBox.x + railBox.width / 2,
        railBox.y + railBox.height / 2
      );
      await page.mouse.wheel(0, 200);
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(before.rail);
    } finally {
      await page.context().close();
    }
  });

  // A STICKY RAIL THAT OUTGROWS THE VIEWPORT PINS ITS TOP AND STRANDS ITS BOTTOM:
  // the part below the fold cannot be reached at any page scroll, because the
  // element is not moving. The cap is the viewport minus the rail's two insets, and
  // the rail scrolls inside itself past that.
  test("the rail never outgrows a short viewport, and scrolls inside itself", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    const app = appContent(page);
    try {
      await page.setViewportSize(RAIL_SHORT);
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      const rail = app.getByTestId("history-day-rail");
      await expect(rail.getByTestId("intraday-panel")).toBeVisible();
      await expect(rail.getByTestId("history-calendar-open")).toBeVisible();

      const box = (await rail.boundingBox())!;
      // THE SCROLLING BOX IS NOT THE RAIL. The rail caps the height; the box BELOW
      // the chart is what scrolls, so the chart's own area has no scrollable
      // ancestor short of the page (the wheel test above is the behaviour that
      // rests on it). So the cap is read off the rail and the overflow off the box.
      const scroller = app.getByTestId("history-day-rail-scroll");
      const scroll = await scroller.evaluate((el) => ({
        content: el.scrollHeight,
        visible: el.clientHeight,
      }));
      // THE FIXTURE REACHES THE FORBIDDEN STATE. Without this the height assertion
      // below is green on a rail that simply had little in it, which is the shape
      // that passes forever and tests nothing.
      const panelHeight = (await rail
        .getByTestId("intraday-panel")
        .boundingBox())!.height;
      expect(
        panelHeight + scroll.content,
        `the rail holds ${Math.round(panelHeight + scroll.content)}px of content ` +
          `in a ${RAIL_SHORT.height}px viewport`
      ).toBeGreaterThan(RAIL_SHORT.height);
      expect(Math.round(box.height)).toBeLessThanOrEqual(RAIL_SHORT.height);
      expect(
        scroll.content,
        "the layers below the chart overflow their own box"
      ).toBeGreaterThan(scroll.visible);
    } finally {
      await page.context().close();
    }
  });

  // THE UNCHANGED CASE, and it is the half this is most likely to get wrong. One
  // pixel under the threshold, the 1024 the criteria name, and the phone: one
  // column, source order, and the calendar still a door.
  for (const viewport of [BELOW_RAIL, LAPTOP, PHONE]) {
    test(`below the rail threshold (${viewport.width}) the day view is one stacked column with a calendar door`, async ({
      browser,
    }) => {
      test.slow();
      const page = await signIn(browser);
      const app = appContent(page);
      try {
        await page.setViewportSize(viewport);
        await page.goto(dayUrl(TL_CHROME_BUSY_DAY));

        const rail = app.getByTestId("history-day-rail");
        const feed = app.getByTestId("history-feed");
        const panel = rail.getByTestId("intraday-panel");
        const add = rail.getByTestId("history-add");
        await expect(panel).toBeVisible();
        await expect(
          feed.getByTestId("history-row").first() // first-ok: the claim is the column, not a particular row
        ).toBeVisible();

        const [railBox, feedBox, panelBox, addBox] = await settledBoxes([
          rail,
          feed,
          panel,
          add,
        ]);
        // STACKED, NOT BESIDE: the rail ends above the rows begin, and the two share
        // a left edge. The `+ 1` absorbs sub-pixel layout only.
        expect(
          railBox.y + railBox.height,
          `the rail ends at ${railBox.y + railBox.height}, the rows start at ${
            feedBox.y
          }`
        ).toBeLessThanOrEqual(feedBox.y + 1);
        expect(Math.round(railBox.x)).toBe(Math.round(feedBox.x));
        // #4918's order inside that one column, unchanged: chart, then add layer,
        // then rows.
        expect(panelBox.y).toBeLessThan(addBox.y);
        expect(addBox.y).toBeLessThan(feedBox.y);
        // Nothing is pinned here.
        await expect
          .poll(() => rail.evaluate((el) => getComputedStyle(el).position))
          .toBe("static");
        // AND THE CALENDAR IS STILL A DOOR (#4102's ruling, kept below xl): the
        // trigger stands in the filter row and the open grid is not on the page.
        await expect(app.getByTestId("history-calendar")).toBeVisible();
        await expect(app.getByTestId("history-calendar-open")).toBeHidden();
      } finally {
        await page.context().close();
      }
    });
  }
});
