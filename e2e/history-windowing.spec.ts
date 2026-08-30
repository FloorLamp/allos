import { test, expect } from "./fixtures";
import type { Page, TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath, frozenNow } from "./worker-env";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The record's windowing (issue #2657), inherited from `/timeline` when #3958 phase 2
// retired that route.
//
// The timeline at its default "All · All dates" unrolled 47,251px of individual event
// cards at 390px, and OPENED on far-future goal target dates — the reader's entry
// point was speculative scheduling rather than their own recent history. The feed now
// folds: the last 14 days event-grained, everything older to one collapsible card per
// calendar month. (The FUTURE fold was `/timeline`'s and #3958 does not inherit it —
// the record ends at now — so this spec asserts the future's ABSENCE instead.)
//
// The claim this spec has to keep honest is the one a windowing change can quietly
// break — that nothing was REMOVED, only compressed. So each fold is proved twice: the
// planted entry is absent from the default page, and present after the fold that hides
// it is opened. (The "Oldest" jump was `/timeline`'s header and is gone with it; the
// note where its test stood says what took over.)
//
// Fixture-OWNED (#868), on the spec's OWN profiles (#3106): these fixtures used to
// ride the shared profile 1, whose seeded history sits close enough to
// `getTimeline`'s newest-250 cut that co-resident specs' recent rows pushed OLD_DATE
// off the page — a shard-layout change failing this spec with no timeline change
// anywhere (the 12-shard PR matrix did exactly that; the 4-shard main matrix did
// not). Each test now creates a login + profile pair and plants its goals there, so
// no other spec's writes can reach this feed. The two describes plant DIFFERENT
// goal sets because their ledgers must differ: the windowing tests need the previous
// year absent, so an old day hides behind a MONTH fold rather than a year one, while
// the year roll-up tests need it present.

const DB_PATH = workerDbPath();
const AHEAD_GOAL = "E2E windowing ahead goal";
const RECENT_GOAL = "E2E windowing recent goal";
const OLD_GOAL = "E2E windowing old goal";
const LAST_YEAR_GOAL = "E2E windowing last year goal";

function shiftedDay(days: number): string {
  const d = new Date(frozenNow());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// +45 / −100 days: far enough from both boundaries that no profile timezone can move
// either across the "after today" or the 14-day edge.
const AHEAD_DATE = shiftedDay(45);
const OLD_DATE = shiftedDay(-100);
const OLD_MONTH = OLD_DATE.slice(0, 7);

// −7 days: inside the 14-day recent band in ANY timezone. Every fixture plants one
// recent event because `windowTimelineDays` deliberately auto-opens the newest month
// when the recent band is empty ("a profile that has not logged in three weeks must
// land on its history") — and these tests assert the CLOSED-fold grammar, which only
// a profile with recent history renders.
const RECENT_DATE = shiftedDay(-7);

// −400 days: comfortably inside the PREVIOUS calendar year and nowhere near either of
// its boundaries, so the year roll-up's own edge (a month leaves the current year) is
// exercised without a timezone being able to move the day across a 1 January.
const LAST_YEAR_DATE = shiftedDay(-400);
const LAST_YEAR_MONTH = LAST_YEAR_DATE.slice(0, 7);
const LAST_YEAR = LAST_YEAR_DATE.slice(0, 4);

function withDb<T>(fn: (handle: Database.Database) => T): T {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    return fn(handle);
  } finally {
    handle.close();
  }
}

interface TimelineFixture {
  username: string;
  loginId: number;
  profileId: number;
}

// One login + one profile + this test's goals, nothing shared. The username is
// unique per (purpose, pid, repeatEachIndex) so parallel workers and --repeat-each
// runs never collide, and the password hash is borrowed from the seeded member login
// so `loginAs` works with the standard member password.
function createTimelineFixture(
  testInfo: TestInfo,
  purpose: string,
  goals: readonly (readonly [string, string])[]
): TimelineFixture {
  return withDb((db) => {
    const suffix = `${purpose}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_timeline_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    db.transaction(() => {
      const passwordHash = (
        db
          .prepare("SELECT password_hash FROM logins WHERE username = ?")
          .get(E2E_LOGIN_DAILY) as { password_hash: string }
      ).password_hash;
      profileId = createFixtureProfile(db, `Timeline ${suffix}`);
      loginId = Number(
        db
          .prepare(
            "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
          )
          .run(username, passwordHash).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO login_profiles (login_id, profile_id, access)
         VALUES (?, ?, 'write')`
      ).run(loginId, profileId);
      const insert = db.prepare(
        `INSERT INTO goals (profile_id, title, target_date, status)
         VALUES (?, ?, ?, 'active')`
      );
      for (const [title, date] of goals) insert.run(profileId, title, date);
    }).immediate();
    return { username, loginId, profileId };
  });
}

function destroyTimelineFixture(fixture: TimelineFixture): void {
  withDb((db) => {
    db.transaction(() => {
      db.prepare("DELETE FROM sessions WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_profiles WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM login_settings WHERE login_id = ?").run(
        fixture.loginId
      );
      db.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
      db.prepare("DELETE FROM goals WHERE profile_id = ?").run(
        fixture.profileId
      );
      destroyFixtureProfile(db, fixture.profileId);
    }).immediate();
  });
}

const WINDOW_GOALS = [
  [AHEAD_GOAL, AHEAD_DATE],
  [RECENT_GOAL, RECENT_DATE],
  [OLD_GOAL, OLD_DATE],
] as const;

// A FOLD TOGGLE IS NOT IDEMPOTENT, so `followLink` is the wrong helper for it — and
// this is measured rather than reasoned. Under `--repeat-each=3` the year-shut case
// failed one run in three: `followLink` RE-CLICKS while it waits for the URL to
// commit, the first click had already shut the year, and the second re-opened it, so
// the URL settled on `?open=2025` and the assertion read it as the very defect the
// test exists to catch ("a toggle that read set membership would answer closed and ADD
// one"). The helper's own error message names this case. `hydratedClick` waits for the
// handler and then clicks ONCE — its comment says "the toggle can never be
// double-fired" — and the URL is asserted separately.
async function toggleFold(
  page: Page,
  testId: string,
  destination: RegExp
): Promise<void> {
  await hydratedClick(page, page.getByTestId(testId));
  await expect(page).toHaveURL(destination);
}

test.describe("the record's windowing (#2657)", () => {
  test("the feed opens on recent history — the future and older months are folded away", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "w-open", WINDOW_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/history");

      // THE FEED OPENS ON A DAY, NOT ON A FOLD. `/timeline` led with its future fold;
      // #3958 rules that fold NOT inherited — "the record ends at now", the future
      // belongs to /upcoming — so the first thing here is a recent day group.
      const first = page.getByTestId("history-feed").locator("section").first(); // first-ok: asserts WHICH element leads the feed — the assertion is about position
      await expect(first).toHaveAttribute("data-testid", "history-day");

      // THE FUTURE IS ABSENT, AND BOTH HALVES ARE ASSERTED. A "no ahead fold" check
      // alone passes on a page that renders nothing at all, so the future-dated goal
      // is asserted missing BESIDE a recent one asserted present — the fixture seeds
      // both, so a record that had simply failed to render would fail here.
      await expect(page.getByTestId("history-fold-ahead")).toHaveCount(0);
      await expect(page.getByText(AHEAD_GOAL)).toHaveCount(0);
      await expect(page.locator(`#timeline-day-${AHEAD_DATE}`)).toHaveCount(0);
      await expect(page.getByText(RECENT_GOAL)).toBeVisible();

      // The old month IS folded: a card, closed, with its rows unrendered. The
      // always-present count (#1504 grammar) rides on it — the amount never hides,
      // only the vertical cost of it does.
      const month = page.getByTestId(`history-fold-${OLD_MONTH}`);
      await expect(month).toHaveAttribute("data-fold-open", "false");
      await expect(
        page.getByTestId(`history-fold-${OLD_MONTH}-counts`)
      ).toHaveText(/^\d+ events? · \d+ days?$/);
      await expect(page.getByText(OLD_GOAL)).toHaveCount(0);
      await expect(page.locator(`#timeline-day-${OLD_DATE}`)).toHaveCount(0);
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });

  test("a month card expands in place, and the open fold is in the URL", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "w-expand", WINDOW_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/history");

      await toggleFold(
        page,
        `history-fold-${OLD_MONTH}-toggle`,
        new RegExp(`open=${OLD_MONTH}`)
      );

      await expect(
        page.getByTestId(`history-fold-${OLD_MONTH}-toggle`)
      ).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(`#timeline-day-${OLD_DATE}`)).toBeVisible();
      await expect(page.getByText(OLD_GOAL)).toBeVisible();

      // "The other folds stay shut" was asserted here against the ahead fold, which
      // #3958 does not inherit — and this fixture plants no previous year, so after
      // the retirement OLD_MONTH is the only fold on the page and there is no other
      // one to make a claim about. The year describe below covers "opening one fold
      // is not opening the page" on a fixture that actually has two.

      // And it closes again, back to the fold-free URL.
      await toggleFold(page, `history-fold-${OLD_MONTH}-toggle`, /\/history$/);
      await expect(page.getByText(OLD_GOAL)).toHaveCount(0);
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });

  // THE "OLDEST" JUMP IS NOT HERE, AND ITS TEST WENT WITH IT. `/timeline`'s header
  // carried Latest/Oldest links whose whole subtlety was opening the fold that hid
  // the destination; the record's header carries no jumps — the jump rail (#2657
  // item 4, e2e/history-scrubber.spec.ts) is how you reach a distant period now, and
  // it solves the same problem by the same means (a stop for a folded period carries
  // the key that opens it). Recorded rather than silently dropped.
});

// YEARS ROLL UP (#2657 item 6). One level up, same grammar, same claim to keep honest:
// nothing removed, only compressed.
//
// Every case here drives `?kind=goal` rather than the bare feed, and that is not
// incidental. The default view stops at the newest 300 events, which on a seeded
// profile is roughly three months — a year card cannot appear in a view whose oldest
// event is twelve weeks old, so measuring the roll-up there would prove nothing. The
// goal category is thin enough that 300 events reaches the whole history, which is
// exactly the shape (a long, sparse ledger) the year level exists for.
const YEAR_GOALS = [
  [AHEAD_GOAL, AHEAD_DATE],
  [RECENT_GOAL, RECENT_DATE],
  [OLD_GOAL, OLD_DATE],
  [LAST_YEAR_GOAL, LAST_YEAR_DATE],
] as const;

test.describe("the record's year roll-up (#2657)", () => {
  const YEAR_FEED = `/history?kind=goal` as const;

  test("an earlier year is one card, and neither its months nor its days are rendered", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "y-card", YEAR_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(YEAR_FEED);

      const year = page.getByTestId(`history-fold-${LAST_YEAR}`);
      await expect(year).toHaveAttribute("data-fold-open", "false");
      // A year counts in MONTHS — months are what a tap reveals (#1504 always-present).
      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR}-counts`)
      ).toHaveText(/^\d+ events? · \d+ months?$/);

      // The month card inside is not merely collapsed, it is absent — which is what
      // makes the roll-up a saving in bytes rather than in `display: none`.
      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR_MONTH}`)
      ).toHaveCount(0);
      await expect(page.getByText(LAST_YEAR_GOAL)).toHaveCount(0);
      await expect(page.locator(`#timeline-day-${LAST_YEAR_DATE}`)).toHaveCount(
        0
      );
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });

  test("opening a year reveals its month cards and still none of their days", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "y-open", YEAR_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(YEAR_FEED);

      await toggleFold(
        page,
        `history-fold-${LAST_YEAR}-toggle`,
        new RegExp(`open=${LAST_YEAR}(&|$)`)
      );

      const month = page.getByTestId(`history-fold-${LAST_YEAR_MONTH}`);
      await expect(month).toBeVisible();
      await expect(month).toHaveAttribute("data-fold-open", "false");
      await expect(month).toHaveAttribute("data-fold-nested", "true");
      // A year opens onto a stack of month cards. If it opened onto days it would be a
      // second name for the same level, and the compression would be gone.
      await expect(page.getByText(LAST_YEAR_GOAL)).toHaveCount(0);
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });

  test("a bare month deep link still lands, because the year around it opens by derivation", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "y-deeplink", YEAR_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The link shape that existed before years shipped. It has to keep working, or
      // every bookmark and every shared `?open=YYYY-MM` became a link to nothing.
      await page.goto(`${YEAR_FEED}&open=${LAST_YEAR_MONTH}`);

      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR}-toggle`)
      ).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR_MONTH}-toggle`)
      ).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByText(LAST_YEAR_GOAL)).toBeVisible();
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });

  test("a year opened by its month can be shut again from its own control", async ({
    browser,
  }, testInfo) => {
    const fixture = createTimelineFixture(testInfo, "y-shut", YEAR_GOALS);
    const page = await loginAs(browser, {
      username: fixture.username,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The sharp edge of deriving the year's state: it holds no `?open=` key of its
      // own here, so a toggle that read set membership would answer "closed" and ADD
      // one — the tap would land on a shut-looking control and nothing would close.
      await page.goto(`${YEAR_FEED}&open=${LAST_YEAR_MONTH}`);
      await expect(page.getByText(LAST_YEAR_GOAL)).toBeVisible();

      await toggleFold(
        page,
        `history-fold-${LAST_YEAR}-toggle`,
        /\/history\?kind=goal$/
      );

      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR}`)
      ).toHaveAttribute("data-fold-open", "false");
      await expect(page.getByText(LAST_YEAR_GOAL)).toHaveCount(0);
      await expect(
        page.getByTestId(`history-fold-${LAST_YEAR_MONTH}`)
      ).toHaveCount(0);
    } finally {
      await page.context().close();
      destroyTimelineFixture(fixture);
    }
  });
});
