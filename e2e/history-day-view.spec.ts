import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
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

  test("both sticky strips park below a forged top inset (#4558)", async ({
    browser,
  }) => {
    test.slow();
    const page = await signIn(browser);
    try {
      await page.goto(dayUrl(TL_CHROME_BUSY_DAY));
      await chromeReady(page);

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

      const measure = async (inset: number) => {
        await page.evaluate(
          (px) =>
            document.documentElement.style.setProperty(
              "--top-edge-inset",
              `${px}px`
            ),
          inset
        );
        await scrollTo(page, 0);
        await expect(nav).toHaveAttribute("data-hidden", "false");
        const [dayAtRest] = await settledBoxes([day]);
        const maxScroll = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight
        );
        const dayFrom = Math.round(dayAtRest.y + 40);
        expect(
          maxScroll - dayFrom,
          "the busy day has a sticky window"
        ).toBeGreaterThan(100);

        await scrollTo(page, dayFrom);
        await expect(nav).toHaveAttribute("data-hidden", "true");
        const dayY = await parkedY(day, dayFrom, dayFrom + 48);

        const deep = await scrollTo(page, maxScroll);
        await expect(nav).toHaveAttribute("data-hidden", "true");
        const navFrom = deep - 100;
        await scrollTo(page, navFrom);
        await expect(nav).toHaveAttribute("data-hidden", "false");
        const navY = await parkedY(nav, navFrom, navFrom - 48);
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
