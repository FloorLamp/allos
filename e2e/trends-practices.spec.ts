import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { followLink } from "./helpers";

// Issue #1632, the rendered half: wellness practices finally have a Trends presence.
//
// `/trends` gains a **Practices** part between the starred grid and the body census:
// per-practice weeks-in-range cells, cadence against the declared min–max band, and a
// session-length chart for the modalities that record minutes. What this spec pins:
//
//   • the lens is an anchored part of the landing surface (`/trends#practices`), not
//     a fifth tab;
//   • the weeks-in-range strip renders the practice domain's OWN three verdicts —
//     at ceiling, floor met, under floor — over a ledger this spec owns end to end;
//   • the consistency headline states exactly what those cells show — a RATE over
//     completed weeks, with no run appended to it (#1966);
//   • a duration-logging practice gets its session-length chart and a one-tap
//     practice does not;
//   • an UNTRACKED practice (sessions, no weekly cadence) stays out — it has no range
//     to be in;
//   • every card taps back through to /wellness (#1620).
//
// Fixture hygiene (#868): unique practice names, every row deleted in `finally`, and
// no assertion about a shared-seed practice — profile 1 seeds a red-light target of
// its own, which legitimately renders beside these.

const RANGED = "Trend Sauna (e2e)";
const FLOOR_ONLY = "Trend Breathwork (e2e)";
const UNTRACKED = "Trend Journaling (e2e)";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The frozen run clock as a YYYY-MM-DD calendar day, `back` days earlier.
function dayBack(back: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// ── Week-mode-agnostic offsets ──────────────────────────────────────────────
// Nothing here touches the profile's week mode or week-start day (other specs share
// this worker DB), so every offset below has to produce the same verdict under ANY
// week boundary.
//
//   • DENSE is sixteen CONSECUTIVE days. Sixteen consecutive days always contain at
//     least one COMPLETE aligned 7-day week (6 + 7 + 3 is the worst case), and a
//     complete week of them logs seven days — comfortably at or above any ceiling
//     below. So at least one cell is deterministically AT CEILING.
//   • LONE is a single day with no other log within seven days of it in either
//     direction, so its week counts exactly one logged day — deterministically FLOOR
//     MET for a floor of 1, and never at a ceiling of 2.
//   • Weeks the fixture never touches are deterministically UNDER FLOOR.
//
// Every offset is at least 8 days back, so none can land in the in-progress week the
// ledger deliberately excludes.
const DENSE = Array.from({ length: 16 }, (_, i) => 8 + i);
const LONE = 45;
// One day per completed week whatever the boundary: any seven consecutive days hold
// exactly one member of a 7-periodic set.
const ONE_PER_WEEK = [8, 15, 22, 29];

function seedTarget(
  db: Database.Database,
  name: string,
  floor: number,
  ceiling: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week,
            per_week_max, created_at)
         VALUES (1, 'practice', ?, ?, ?, ?, ?)`
      )
      .run(name, name.toLowerCase(), floor, ceiling, `${dayBack(180)} 08:00:00`)
      .lastInsertRowid
  );
}

function logSession(
  db: Database.Database,
  name: string,
  back: number,
  minutes: number | null
): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
     VALUES (1, ?, ?, ?)`
  ).run(name, dayBack(back), minutes);
}

function cleanUp(db: Database.Database, targetIds: number[]): void {
  const dropLogs = db.prepare("DELETE FROM practice_logs WHERE practice = ?");
  for (const name of [RANGED, FLOOR_ONLY, UNTRACKED]) dropLogs.run(name);
  const dropTarget = db.prepare("DELETE FROM frequency_targets WHERE id = ?");
  const dropSuppression = db.prepare(
    "DELETE FROM upcoming_dismissals WHERE signal_key = ?"
  );
  for (const id of targetIds) {
    dropTarget.run(id);
    dropSuppression.run(`practice:${id}`);
  }
}

test("the wellness lens renders each practice's completed weeks in range (#1632)", async ({
  page,
}) => {
  const db = openDb();
  const targets: number[] = [];
  try {
    // A 1–2×/week range: the dense block reaches the ceiling, the lone day meets the
    // floor exactly, and the untouched weeks are under it.
    targets.push(seedTarget(db, RANGED, 1, 2));
    for (const back of DENSE) logSession(db, RANGED, back, 20);
    logSession(db, RANGED, LONE, null);

    await page.goto("/trends#practices");

    // An anchored part of the landing surface, reached by its own fragment.
    const section = page.locator("section#practices");
    await expect(section).toHaveCount(1);
    await expect(section).toBeInViewport();
    await expect(section.getByTestId("trends-practices")).toBeVisible();

    const card = page
      .getByTestId("practice-cadence-card")
      .filter({ hasText: RANGED });
    await expect(card).toBeVisible();
    // The declared cadence is the headline, in the practice domain's own phrasing.
    await expect(card.getByTestId("chart-card-headline")).toHaveText(
      "1–2×/week"
    );

    // All three verdicts, each from a deterministic part of the ledger above.
    const cellsWith = (verdict: string) =>
      card.locator(
        `[data-testid="practice-week-cell"][data-verdict="${verdict}"]`
      );
    await expect.poll(() => cellsWith("at-ceiling").count()).toBeGreaterThan(0);
    await expect.poll(() => cellsWith("met").count()).toBeGreaterThan(0);
    await expect.poll(() => cellsWith("under").count()).toBeGreaterThan(0);

    // The consistency headline says exactly what the cells show: an at-ceiling week
    // is a met week, never a separate failure state.
    const cells = card.getByTestId("practice-week-cell");
    const weeks = await cells.count();
    const under = await cellsWith("under").count();
    await expect(card).toContainText(
      `Floor met in ${weeks - under} of ${weeks} completed weeks`
    );
    // …and NOTHING about a run (#1966). This ledger is the case that used to
    // print one: DENSE reaches the newest completed weeks, so the retired
    // "· N-week streak" clause would be on this very card. The rate above is the
    // whole sentence now, and a missed week nudges it instead of zeroing it.
    await expect(card).not.toContainText(/streak/i);

    // A RANGED practice names all three states, including the calm at-ceiling one.
    const legend = card.getByTestId("practice-weeks-legend");
    await expect(legend).toContainText("At weekly maximum");
    await expect(legend).toContainText("Floor met");
    await expect(legend).toContainText("Under floor");
  } finally {
    cleanUp(db, targets);
    db.close();
  }
});

test("session length is charted only for the practices that record minutes (#1632)", async ({
  page,
}) => {
  const db = openDb();
  const targets: number[] = [];
  try {
    targets.push(seedTarget(db, RANGED, 1, 2));
    targets.push(seedTarget(db, FLOOR_ONLY, 1, null));
    for (const back of ONE_PER_WEEK) {
      logSession(db, RANGED, back, 20 + back);
      // Same cadence, no minutes ever recorded — a one-tap practice.
      logSession(db, FLOOR_ONLY, back, null);
    }

    await page.goto("/trends#practices");

    await expect(
      page.getByTestId("practice-duration-card").filter({ hasText: RANGED })
    ).toBeVisible();
    await expect(
      page.getByTestId("practice-duration-card").filter({ hasText: FLOOR_ONLY })
    ).toHaveCount(0);
    // The one-tap practice still gets its cadence card — only the minutes chart is
    // withheld, because a zero-filled duration line would invent minutes.
    const floorOnly = page
      .getByTestId("practice-cadence-card")
      .filter({ hasText: FLOOR_ONLY });
    await expect(floorOnly).toBeVisible();
    await expect(floorOnly.getByTestId("chart-card-headline")).toHaveText(
      "1×/week"
    );
    // No ceiling declared, so the legend does not offer the at-ceiling state.
    await expect(
      floorOnly.getByTestId("practice-weeks-legend")
    ).not.toContainText("At weekly maximum");
  } finally {
    cleanUp(db, targets);
    db.close();
  }
});

test("an untracked practice stays out, and a card taps back to Wellness (#1632)", async ({
  page,
}) => {
  const db = openDb();
  const targets: number[] = [];
  try {
    targets.push(seedTarget(db, RANGED, 1, 2));
    for (const back of ONE_PER_WEEK) {
      logSession(db, RANGED, back, 20);
      // Sessions but no weekly cadence: history without a range.
      logSession(db, UNTRACKED, back, null);
    }

    await page.goto("/trends#practices");

    const card = page
      .getByTestId("practice-cadence-card")
      .filter({ hasText: RANGED });
    await expect(card).toBeVisible();
    // The untracked practice appears nowhere on the lens.
    await expect(
      page.getByTestId("trends-practices").getByText(UNTRACKED)
    ).toHaveCount(0);

    // The lens is an entry point back to the page that owns the habit (#1620).
    await followLink(
      page,
      card.getByTestId("chart-card-header-link"),
      /\/wellness$/
    );
    await expect(
      page.getByTestId("wellness-practice-card").filter({ hasText: RANGED })
    ).toBeVisible();
  } finally {
    cleanUp(db, targets);
    db.close();
  }
});
