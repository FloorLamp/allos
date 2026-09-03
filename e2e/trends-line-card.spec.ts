import { test, expect } from "./fixtures";
import { type Locator, type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import {
  shiftDateStr,
  utcInstant,
  utcMinute,
  zonedWallTimeToUtc,
} from "@/lib/date";

// THE DAILY LINE CARD (#4924): what draws, what the stroke may claim, and where
// the sentences under a chart go.
//
// Filed from a screenshot of /trends and the phrase "why are these so janky".
// Three of the six defects only exist as PIXELS — a reading that renders as
// nothing, a stroke drawn to a half-finished day, a caption printed over a
// footer — so the assertions here are geometric and structural. A class or count
// check would have passed the whole time the picture was lying.
//
// One fixture profile per test, seeded with the exact shape it asserts, so
// nothing depends on the shared seed's cadence and --repeat-each groups cannot
// collide.

const DB_PATH = workerDbPath();
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;
// The frozen run's profile-local today (the pinned zone keeps the local date
// equal to the frozen instant's UTC date — see e2e/pinned-timezone.ts).
const TODAY = frozenNow().toISOString().slice(0, 10);
const day = (back: number) => shiftDateStr(TODAY, -back);

// The card's density threshold (components/chart-scaffold.tsx). Re-stated as the
// number the FIXTURE has to clear rather than imported, so a fixture that stopped
// clearing it shows up here as a wrong number instead of silently following it.
const DENSE_SERIES_POINTS = 30;
// Thirty-seven readings: a densely-logged run of 36 plus the lone one. Above the
// threshold, which is exactly why the dot layer had turned itself off over the
// lone reading's head.
const DENSE_RUN_DAYS = 36;

interface Fixture {
  username: string;
  loginId: number;
  profileId: number;
}

function createFixture(testInfo: TestInfo, purpose: string): Fixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${purpose}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_linecard_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_DAILY) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Line card ${suffix}`);
        loginId = Number(
          handle
            .prepare(
              "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
            )
            .run(username, passwordHash).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO login_profiles (login_id, profile_id, access)
             VALUES (?, ?, 'write')`
          )
          .run(loginId, profileId);
        // NO timezone override: a profile with no `profile_settings.timezone`
        // row resolves to the INSTANCE zone, which the seed pins to the run's
        // rotating zone (e2e/fixtures.ts asserts the two agree). So this profile
        // follows the pin without opting out of anything, which is what the HR
        // assertions below need — its local today must be the day they seed
        // minutes into.
      })
      .immediate();
    return { username, loginId, profileId };
  } finally {
    handle.close();
  }
}

function destroyFixture(fixture: Fixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        for (const sql of [
          "DELETE FROM sessions WHERE login_id = ?",
          "DELETE FROM login_profiles WHERE login_id = ?",
          "DELETE FROM login_settings WHERE login_id = ?",
          "DELETE FROM logins WHERE id = ?",
        ]) {
          handle.prepare(sql).run(fixture.loginId);
        }
        for (const sql of [
          "DELETE FROM metric_samples WHERE profile_id = ?",
          "DELETE FROM hr_minutes WHERE profile_id = ?",
          "DELETE FROM profile_settings WHERE profile_id = ?",
        ]) {
          handle.prepare(sql).run(fixture.profileId);
        }
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

/** Daily active-calorie totals, one row per named day. */
function seedActiveCalories(profileId: number, days: string[]): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const ins = handle.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'health-connect', 'active_kcal', ?, ?, ?, ?)`
    );
    handle
      .transaction(() => {
        days.forEach((date, i) => {
          ins.run(
            profileId,
            date,
            utcInstant(zonedWallTimeToUtc(TZ, date, "00:00")!),
            utcInstant(zonedWallTimeToUtc(TZ, date, "23:59")!),
            400 + i
          );
        });
      })
      .immediate();
  } finally {
    handle.close();
  }
}

/**
 * HR minute buckets at named profile-LOCAL wall times. Instants are built through
 * `zonedWallTimeToUtc` because the seed pins a rotating per-run timezone (#1417):
 * a naive `${day}THH:MM` string parses as host-UTC and lands on the wrong local
 * day for most of the day, which is exactly the grouping this test is about.
 */
function seedHrMinutes(
  profileId: number,
  minutes: { day: string; at: string; bpm: number }[]
): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const ins = handle.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source)
       VALUES (?, ?, ?, ?, ?, 1, 'oura')`
    );
    handle
      .transaction(() => {
        for (const m of minutes) {
          ins.run(
            profileId,
            utcMinute(zonedWallTimeToUtc(TZ, m.day, m.at)!),
            m.bpm,
            m.bpm - 4,
            m.bpm + 6
          );
        }
      })
      .immediate();
  } finally {
    handle.close();
  }
}

/** The stack member wrapping one metric's card. */
function card(page: Page, id: string): Locator {
  return page.getByTestId(`body-stack-item-${id}`);
}

async function boxes(scope: Locator, selector: string) {
  return scope.locator(selector).evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    })
  );
}

/**
 * The right edge of every stroke a reader can SEE. recharts emits a
 * `recharts-line-curve` path for the marks-and-tooltip line too, and that one is
 * `stroke: none` — its box reaches the last plotted point whether or not any ink
 * does, which is the measurement that flatters a broken stroke.
 */
async function paintedStrokeRight(scope: Locator): Promise<number> {
  const rights = await scope
    .locator("path.recharts-line-curve")
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => getComputedStyle(n).stroke !== "none")
        .map((n) => n.getBoundingClientRect().right)
    );
  expect(rights.length, "no painted stroke to measure").toBeGreaterThan(0);
  return Math.max(...rights);
}

/**
 * Each DATE tick label and its centre x. Both axes render
 * `.recharts-cartesian-axis-tick-value`, so the date ones are picked out by their
 * MM-DD shape rather than by an axis class (recharts 3 renders the axis group
 * whether or not the axis paints).
 */
async function xTicks(scope: Locator) {
  return scope
    .locator(".recharts-cartesian-axis-tick-value")
    .evaluateAll((nodes) =>
      nodes
        // SVG <text>: textContent, not innerText, which SVG elements do not have.
        .map((n) => {
          const r = n.getBoundingClientRect();
          return { label: (n.textContent ?? "").trim(), x: r.x + r.width / 2 };
        })
        .filter((t) => /^\d{2}-\d{2}$/.test(t.label))
    );
}

test("a lone reading between two over-limit holes draws its mark (#4924 fix 3)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo, "isolated");
  // A densely-logged run inside the 90-day window, an over-limit hole (active
  // calories declares a 2-day limit), ONE reading, then silence to today. The run
  // alone is above the density threshold, so resting dots are off for the whole
  // series and the lone reading used to render as nothing at all.
  const run = Array.from({ length: DENSE_RUN_DAYS }, (_, i) => day(88 - i));
  const alone = day(25);
  seedActiveCalories(fixture.profileId, [...run, alone]);
  expect(run.length + 1).toBeGreaterThan(DENSE_SERIES_POINTS);

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/trends?view=all");
    const active = card(page, "active-calories");
    await expect(active).toBeVisible();
    await expect(active.locator("svg.recharts-surface")).toBeVisible();

    // EXACTLY ONE resting mark: the reading no stroke reaches. Every other point
    // in this series is joined to a neighbour, so the clutter rule still governs
    // it and the dot layer is still off for all 36 of them.
    await expect(active.locator("circle.chart-dot")).toHaveCount(1);

    // …and it is AT THAT DATE, read against the axis the reader reads it against.
    // The date-tick policy puts a fortnightly tick on this window, so the lone
    // reading's day falls strictly between two labelled ones: a relationship
    // between elements, where an absolute x would be satisfied by a dot anywhere.
    const [mark] = await boxes(active, "circle.chart-dot");
    const ticks = await xTicks(active);
    const at = (date: string) => {
      const tick = ticks.find((t) => t.label === date.slice(5));
      expect(
        tick,
        `no ${date.slice(5)} tick among ${ticks.map((t) => t.label)}`
      ).toBeDefined();
      return tick!.x;
    };
    const centre = (mark.left + mark.right) / 2;
    expect(centre).toBeGreaterThan(at(day(28)));
    expect(centre).toBeLessThan(at(day(14)));

    // The caption that named a date the plot never showed is still there, and now
    // the plot shows it.
    await expect(
      active.getByTestId("chart-trailing-outage-note")
    ).toBeVisible();
  } finally {
    await page.context().close();
    destroyFixture(fixture);
  }
});

test("today's HR is drawn as the day it is, not the day it will be (#4924 fix 4)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo, "partial");
  // Four complete days and a morning: the frozen clock is mid-day, so today's
  // average is over the minutes so far and nothing else.
  seedHrMinutes(fixture.profileId, [
    ...[4, 3, 2, 1].flatMap((back) =>
      ["02:00", "09:00", "14:00", "21:00"].map((at, i) => ({
        day: day(back),
        at,
        bpm: 68 + i * 3,
      }))
    ),
    ...["02:00", "05:00", "07:00"].map((at) => ({
      day: TODAY,
      at,
      bpm: 52,
    })),
  ]);

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/trends?view=all");
    const hr = card(page, "hr");
    await expect(hr).toBeVisible();
    await expect(hr.locator("svg.recharts-surface")).toBeVisible();

    // THE MARK. Fill means exactness (owner call 3 on #2830), so a bucket the day
    // is still filling is an outline of a value rather than one.
    const hollow = hr.locator("circle[data-inexact]");
    await expect(hollow).toHaveCount(1);

    // THE STROKE. It ends at the last COMPLETE day: the rightmost pixel any line
    // reaches is left of the partial mark, rather than a segment falling from
    // yesterday's average to a half-day's.
    const [partial] = await boxes(hr, "circle[data-inexact]");
    expect(await paintedStrokeRight(hr)).toBeLessThan(partial.left);

    // THE HEADLINE. "52 bpm" with nothing attached reads as your heart rate.
    await expect(hr.getByTestId("chart-card-headline")).toContainText(
      /so far today/
    );
  } finally {
    await page.context().close();
    destroyFixture(fixture);
  }
});

test("a window that ended before today has no partial mark (#4924 fix 4, converse)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo, "past");
  // THE SAME seed. A `partial` flag that is always true passes the test above
  // happily, and this is the reading that says it is not.
  seedHrMinutes(fixture.profileId, [
    ...[4, 3, 2, 1].flatMap((back) =>
      ["02:00", "09:00", "14:00", "21:00"].map((at, i) => ({
        day: day(back),
        at,
        bpm: 68 + i * 3,
      }))
    ),
    ...["02:00", "05:00", "07:00"].map((at) => ({
      day: TODAY,
      at,
      bpm: 52,
    })),
  ]);

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto(`/trends?view=all&from=${day(30)}&to=${day(1)}`);
    const hr = card(page, "hr");
    await expect(hr).toBeVisible();
    await expect(hr.locator("svg.recharts-surface")).toBeVisible();
    // The window's own last day is a finished one, so nothing on this plot is
    // qualified and the headline makes its ordinary claim.
    await expect(hr.locator("circle[data-inexact]")).toHaveCount(0);
    await expect(hr.getByTestId("chart-card-headline")).not.toContainText(
      /so far today/
    );
  } finally {
    await page.context().close();
    destroyFixture(fixture);
  }
});

test("every sentence under a chart sits inside the card, and none overlaps another (#4924 fix 5)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo, "footer");
  // A card carrying BOTH a chart caption (the trailing outage) and a card footer
  // is the shape that printed the two on top of each other. Active calories
  // supplies the caption; the band supplies the rest.
  const run = Array.from({ length: DENSE_RUN_DAYS }, (_, i) => day(88 - i));
  seedActiveCalories(fixture.profileId, [...run, day(25)]);
  seedHrMinutes(
    fixture.profileId,
    [40, 39, 38].flatMap((back) =>
      ["02:00", "09:00", "14:00"].map((at, i) => ({
        day: day(back),
        at,
        bpm: 70 + i,
      }))
    )
  );

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto("/trends?view=all");
    // WAIT FOR THE SENTENCE, NOT THE CARD (#3384). The captions arrive with the
    // lazy chart chunk and are handed up to the band after it mounts; counting
    // bands before that reads an empty page, and every assertion below is about
    // what is IN one.
    const active = card(page, "active-calories");
    await expect(
      active.getByTestId("chart-trailing-outage-note")
    ).toBeVisible();
    const bands = page.getByTestId("chart-card-footer");
    expect(await bands.count()).toBeGreaterThan(0);

    // Measured against THE CARD THE BAND IS IN, not the viewport: text at the
    // right absolute y and flush against its own card's edge is the defect, and
    // only the relationship can see it (#3673/#3920).
    const readings = await bands.evaluateAll((nodes) =>
      nodes.map((band) => {
        const cardEl = band.closest(".card") as HTMLElement | null;
        const cardBox = (cardEl ?? band).getBoundingClientRect();
        const pad = cardEl
          ? parseFloat(getComputedStyle(cardEl).paddingBottom)
          : 0;
        const texts = Array.from(
          band.querySelectorAll<HTMLElement>("p, a, div, span")
        )
          .filter((el) => (el.textContent ?? "").trim().length > 0)
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, text: el.textContent ?? "" };
          });
        return {
          lowest: Math.max(...texts.map((t) => t.bottom)),
          cardBottom: cardBox.bottom,
          pad,
          count: texts.length,
        };
      })
    );
    for (const r of readings) {
      expect(r.count).toBeGreaterThan(0);
      // Inside the card's own bottom padding — the thing "flush against the
      // card's bottom edge with no padding" fails.
      expect(r.lowest).toBeLessThanOrEqual(r.cardBottom - r.pad + 1);
    }

    // …and no two sentences in one band share vertical space. Read on the band's
    // DIRECT children, which is one row per claim.
    const overlaps = await bands.evaluateAll((nodes) =>
      nodes.flatMap((band) => {
        const rows = Array.from(band.children)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0);
        const bad: string[] = [];
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].top < rows[i - 1].bottom - 0.5) {
            bad.push(
              `${band.textContent?.slice(0, 40)}: row ${i} starts at ${rows[i].top} above ${rows[i - 1].bottom}`
            );
          }
        }
        return bad;
      })
    );
    expect(overlaps).toEqual([]);
  } finally {
    await page.context().close();
    destroyFixture(fixture);
  }
});

test("'Fix a range' is not offered for a metric the review page cannot correct (#4924 fix 6)", async ({
  browser,
}, testInfo) => {
  const fixture = createFixture(testInfo, "nofix");
  // Active calories has a live outage and NO `fix=` key — Data → Review can
  // correct weight, body fat, resting HR, HRV and activity distance, and nothing
  // else. The positive half is e2e/bulk-correction.spec.ts.
  const run = Array.from({ length: DENSE_RUN_DAYS }, (_, i) => day(88 - i));
  seedActiveCalories(fixture.profileId, [...run, day(25)]);

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto("/trends?view=all");
    const active = card(page, "active-calories");
    await expect(
      active.getByTestId("chart-trailing-outage-note")
    ).toBeVisible();
    await expect(active.getByTestId("chart-fix-range")).toHaveCount(0);
  } finally {
    await page.context().close();
    destroyFixture(fixture);
  }
});
