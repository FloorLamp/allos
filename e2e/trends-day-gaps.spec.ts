import { test, expect } from "./fixtures";
import { type Locator, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";
import { pinnedTimezone } from "./pinned-timezone";
import { shiftDateStr, utcInstant, zonedWallTimeToUtc } from "@/lib/date";

// DAY-GRAIN GAPS (issue #2258): a day with no reading must occupy space.
//
// Every one of these charts plots on a recharts CATEGORY axis, where x-position is
// the array INDEX. Before the fill, a series that carried only the days it HAD a
// reading for compressed its gaps away: a four-night sync outage rendered as four
// adjacent, evenly spaced points with the stroke bridging them — pixel-identical to
// four consecutive nights. Assertions here are therefore GEOMETRIC and STRUCTURAL
// (where the marks sit, whether the stroke breaks), because a class or count check
// would have passed the entire time the picture was lying.
//
// Each test owns its own login + profile, seeded with the exact gap shape it
// asserts, so nothing depends on the shared seed's cadence and --repeat-each groups
// can never collide.

const DB_PATH = workerDbPath();
const TZ = pinnedTimezone(frozenNow().toISOString()).zone;
// The frozen run's profile-local today (the pinned zone keeps the local date equal
// to the frozen instant's UTC date — see e2e/pinned-timezone.ts).
const TODAY = frozenNow().toISOString().slice(0, 10);
const day = (back: number) => shiftDateStr(TODAY, -back);

interface GapFixture {
  username: string;
  loginId: number;
  profileId: number;
}

function createGapFixture(testInfo: TestInfo, purpose: string): GapFixture {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${purpose}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_gaps_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    handle
      .transaction(() => {
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_DAILY) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Gap ${suffix}`);
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
        // Pin the profile's timezone to the run's, so every seeded instant below
        // lands on the calendar day this spec names.
        handle
          .prepare(
            `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)`
          )
          .run(profileId, TZ);
      })
      .immediate();
    return { username, loginId, profileId };
  } finally {
    handle.close();
  }
}

function destroyGapFixture(fixture: GapFixture): void {
  const handle = new Database(DB_PATH);
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        handle
          .prepare("DELETE FROM sessions WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_profiles WHERE login_id = ?")
          .run(fixture.loginId);
        handle
          .prepare("DELETE FROM login_settings WHERE login_id = ?")
          .run(fixture.loginId);
        handle.prepare("DELETE FROM logins WHERE id = ?").run(fixture.loginId);
        handle
          .prepare("DELETE FROM body_metrics WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM metric_samples WHERE profile_id = ?")
          .run(fixture.profileId);
        handle
          .prepare("DELETE FROM profile_settings WHERE profile_id = ?")
          .run(fixture.profileId);
        destroyFixtureProfile(handle, fixture.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

// The x of every plotted dot, left to right, inside one chart.
async function dotCentres(scope: Locator): Promise<number[]> {
  return scope.locator(".recharts-dot").evaluateAll((nodes) =>
    nodes
      .map((n) => n.getBoundingClientRect())
      .map((r) => r.x + r.width / 2)
      .sort((a, b) => a - b)
  );
}

test("a sparse weight series is spaced by the CALENDAR, not by reading order", async ({
  browser,
}, testInfo) => {
  const fixture = createGapFixture(testInfo, "weight");
  const handle = new Database(DB_PATH);
  try {
    // Four weigh-ins inside the 90-day default window: an ADJACENT pair at the
    // start, then two readings 30 and 40 days later. Before the fill, all four sat
    // one category apart — the one-day gap and the thirty-day gap drew the same
    // width. Now the pixel distances must be proportional to the elapsed days.
    const stmt = handle.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, 'manual')"
    );
    handle
      .transaction(() => {
        stmt.run(fixture.profileId, day(80), 82.0);
        stmt.run(fixture.profileId, day(79), 81.8);
        stmt.run(fixture.profileId, day(49), 80.4);
        stmt.run(fixture.profileId, day(9), 79.1);
      })
      .immediate();
  } finally {
    handle.close();
  }

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/trends/metric/weight");
    const chart = page.getByTestId("metric-detail-chart");
    await expect(chart).toBeVisible();

    // #2029 PARITY: `data-points` counts the fold's REAL readings. Densification
    // happens inside the card, below this boundary, so the readings table and this
    // number still agree with each other and not with the calendar.
    await expect(chart).toHaveAttribute("data-points", "4");

    // The dot-density threshold counts real readings too — four dots, not the 81
    // calendar days now on the axis.
    await expect
      .poll(async () => await chart.locator(".recharts-dot").count())
      .toBe(4);

    const xs = await dotCentres(chart);
    const oneDay = xs[1] - xs[0];
    const thirtyDays = xs[2] - xs[1];
    const fortyDays = xs[3] - xs[2];
    expect(oneDay).toBeGreaterThan(0);
    // Proportionality, with generous slack for rounding and axis padding: the
    // 30-day span must be an order of magnitude wider than the 1-day one, and the
    // 40-day span wider still. Under the old compressed axis all three were equal.
    expect(thirtyDays).toBeGreaterThan(oneDay * 10);
    expect(fortyDays).toBeGreaterThan(thirtyDays);
  } finally {
    await page.context().close();
    destroyGapFixture(fixture);
  }
});

test("a multi-night sleep outage BREAKS the duration stroke and says so on hover", async ({
  browser,
}, testInfo) => {
  const fixture = createGapFixture(testInfo, "sleep");
  const handle = new Database(DB_PATH);
  try {
    // Three nights, a four-night outage, three more nights, then three nights of
    // nothing at all up to today. Inside the Sleep page's 14-day window that is an
    // INTERIOR hole (the stroke must break) plus a TRAILING hole (the live-outage
    // signal the fill deliberately keeps).
    const stmt = handle.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'oura', 'sleep_min', ?, ?, ?, ?)`
    );
    handle
      .transaction(() => {
        for (const [back, minutes] of [
          [13, 430],
          [12, 445],
          [11, 410],
          [6, 455],
          [5, 425],
          [4, 440],
        ] as const) {
          const wakeDay = day(back);
          stmt.run(
            fixture.profileId,
            wakeDay,
            // Instants built against the PROFILE's timezone — a naive
            // `${day}T23:00` string sorts outside the day window at a negative
            // UTC offset, and the pinned zone rotates per run.
            utcInstant(
              zonedWallTimeToUtc(TZ, shiftDateStr(wakeDay, -1), "23:00")!
            ),
            utcInstant(zonedWallTimeToUtc(TZ, wakeDay, "06:30")!),
            minutes
          );
        }
      })
      .immediate();
  } finally {
    handle.close();
  }

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/sleep");
    const card = page.getByTestId("sleep-duration-trend");
    await expect(card).toBeVisible();

    // Six nights → six dots. Nulls carry no mark at all.
    await expect
      .poll(async () => await card.locator(".recharts-dot").count())
      .toBe(6);

    // THE ASSERTION THIS ISSUE EXISTS FOR: the path is drawn in SEGMENTS. One `M`
    // per segment, so a broken stroke has two — a bridged one has exactly one, which
    // is what a compressed axis produced no matter how many nights were missed.
    const d = await card
      .locator(".recharts-line-curve")
      .first() // first-ok: the card owns exactly one line; the average is a ReferenceLine, not a curve
      .getAttribute("d");
    expect(d).toBeTruthy();
    expect((d!.match(/M/g) ?? []).length).toBe(2);

    // And hovering INSIDE the hole names the absence rather than opening an
    // unlabelled empty box (or printing Number(null) as a real zero).
    const xs = await dotCentres(card);
    const gapX = (xs[2] + xs[3]) / 2;
    const box = (await card.locator(".recharts-wrapper").boundingBox())!;
    const tip = card.locator(".recharts-tooltip-wrapper");
    await expect(async () => {
      await page.mouse.move(5, 5); // leave the chart so the next move re-enters
      await page.mouse.move(gapX, box.y + box.height / 2);
      // A 1px nudge after the entry: recharts activates its tooltip on a FRESH
      // mousemove, and a move that lands where the pointer already sat emits none.
      await page.mouse.move(gapX + 1, box.y + box.height / 2 + 1);
      expect((await tip.innerText()).trim()).toContain("No data");
    }).toPass({ timeout: 30_000 }); // topass-ok: recharts opens the tooltip only after a hover mousemove — re-hover per attempt, no single awaitable render event; 30s is the suite's declared budget for a loaded CI shard, not a retry
  } finally {
    await page.context().close();
    destroyGapFixture(fixture);
  }
});

test("the macros chart obeys the Trends range instead of plotting all history", async ({
  browser,
}, testInfo) => {
  const fixture = createGapFixture(testInfo, "macros");
  const handle = new Database(DB_PATH);
  try {
    const stmt = handle.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
    );
    const logDay = (back: number) => {
      const date = day(back);
      for (const [metric, value] of [
        ["protein_g", 95],
        ["carbs_g", 210],
        ["fat_g", 65],
        ["fiber_g", 28],
      ] as const) {
        stmt.run(
          fixture.profileId,
          metric,
          date,
          utcInstant(zonedWallTimeToUtc(TZ, date, "12:00")!),
          utcInstant(zonedWallTimeToUtc(TZ, date, "12:30")!),
          value
        );
      }
    };
    handle
      .transaction(() => {
        logDay(200); // far outside any selected window — the half the fill cannot fix
        logDay(6);
        logDay(2);
      })
      .immediate();
  } finally {
    handle.close();
  }

  const page = await loginAs(browser, {
    username: fixture.username,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const from = day(6);
    await page.goto(`/trends?tab=nutrition&from=${from}&to=${TODAY}`);
    const macros = page.getByTestId("nutrition-macros-chart");
    await expect(macros).toBeVisible();
    await expect(macros.getByText("Fiber", { exact: true })).toBeVisible();

    // SVG <text>, so read textContent — innerText is a layout property HTML
    // elements have and SVG ones do not.
    const ticks = await macros
      .locator(".recharts-cartesian-axis-tick-value")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ""));
    const label = (date: string) => date.slice(5);
    // The 200-day-old log is OUT of the selected window and must not be charted —
    // before #2258 §4 this chart ignored the range control outright.
    expect(ticks).not.toContain(label(day(200)));
    // …and the window's own last day is on the axis, even though nothing was
    // logged on it: the trailing run of empty slots is "you stopped logging".
    expect(ticks).toContain(label(TODAY));
  } finally {
    await page.context().close();
    destroyGapFixture(fixture);
  }
});
