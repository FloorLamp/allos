import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { hydratedClick } from "./helpers";
import { utcInstant, zonedWallTimeToUtc } from "../lib/date";

// What an ACTIVE illness episode costs a phone (issue #2612).
//
// Mobile-viewport spec because the whole claim is layout at 390px: the census
// measured `/medical/episodes/[id]` at 4556px against 2631px for the identical
// profile with the episode resolved, and both blocks in that delta grew linearly
// with doses × illness days. At 1280px neither assertion below is interesting —
// the legend wraps once and the day table has room — which is exactly why the
// regression shipped.
//
// Two claims, both MEASURED rather than eyeballed:
//   1. The dose caption under the History chart is bounded by DISTINCT medication,
//      not by dose. It used to render one timestamped entry per administration —
//      the same rows the per-day table below carries verbatim — so the page paid
//      that height twice.
//   2. The History opens on the illness signal when the window's routine `may`
//      intake would outnumber it, with nothing removed and "All" one tap away.
//
// The resolved case must not regress while the active one is fixed, so the second
// test builds its own CLOSED episode and asserts the same properties there.
//
// FIXTURE (#868 hygiene): the spec owns every row it asserts on — uniquely-named
// routine supplements with their administrations, and (for the resolved case) its
// own episode row and symptom logs. All of it is deleted in `beforeEach` and again
// in a `finally`, and nothing from the shared seed is exact-counted. Dose instants
// go through `zonedWallTimeToUtc` on the profile's own timezone (#1417): the
// episode groups its ledger by profile-LOCAL day, so a naive zoneless string would
// file doses on the wrong day in any non-UTC zone.

// Uniquely-named routine stack: `may`-obligation supplements, which is what the
// episode assembly gathers and what a real profile's daily stack is filed as.
const STACK = [
  "E2e Fold Creatine",
  "E2e Fold Whey",
  "E2e Fold Iron",
  "E2e Fold Calcium",
  "E2e Fold Magnesium",
  "E2e Fold Zinc",
];
const PROFILE = 1;
// The spec's own CLOSED episode, far enough back that it cannot collide with a
// seeded day (symptom_logs is UNIQUE on profile+date+symptom).
const RESOLVED_SITUATION = "E2e Fold Resolved Illness";
const RESOLVED_SYMPTOMS = ["e2e-fold-ache", "e2e-fold-cough"];

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function deleteFixtureRows(db: Database.Database): void {
  const names = STACK.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = ? AND name IN (${names}))`
  ).run(PROFILE, ...STACK);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name IN (${names})`
  ).run(PROFILE, ...STACK);
  db.prepare(
    `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom IN (?, ?)`
  ).run(PROFILE, ...RESOLVED_SYMPTOMS);
  db.prepare(
    `DELETE FROM illness_episodes WHERE profile_id = ? AND situation = ?`
  ).run(PROFILE, RESOLVED_SITUATION);
}

// `offset` days from the frozen run instant, on the profile's own calendar.
function localDay(tz: string, offset: number): string {
  const at = new Date(frozenNow().getTime() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

function profileTimezone(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
    )
    .get(PROFILE) as { value: string } | undefined;
  return row?.value || "UTC";
}

// The ongoing episode's id and its inclusive day window, read from the row the
// page itself resolves (`end_date IS NULL` = open, #2232 semantics).
function openEpisode(
  db: Database.Database,
  tz: string
): { id: number; days: string[] } {
  const row = db
    .prepare(
      `SELECT id, start_date FROM illness_episodes
        WHERE profile_id = ? AND end_date IS NULL
        ORDER BY start_date IS NULL, start_date DESC, id DESC LIMIT 1`
    )
    .get(PROFILE) as { id: number; start_date: string | null } | undefined;
  expect(
    row,
    "the seed gives profile 1 an ongoing illness episode"
  ).toBeTruthy();
  const today = localDay(tz, 0);
  const start = row!.start_date ?? today;
  // Walk the profile's own calendar rather than parsing a date string into an
  // instant — the window is a run of local DAYS, and a day is not a lesser instant.
  const days: string[] = [];
  for (let offset = -30; offset <= 0; offset += 1) {
    const day = localDay(tz, offset);
    if (day >= start && day <= today) days.push(day);
  }
  return { id: row!.id, days };
}

// One routine dose per stack item per episode day — the shape the census found:
// an ordinary daily supplement stack, every item logged, filling the window.
function seedRoutineStack(
  db: Database.Database,
  days: string[],
  tz: string
): number {
  let logs = 0;
  STACK.forEach((name, index) => {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'may')`
        )
        .run(PROFILE, name).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 serving', 'anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    for (const day of days) {
      // A STATED administration instant on the profile's own clock (#1417).
      const clock = `0${7 + index}`.slice(-2);
      const occurred = zonedWallTimeToUtc(tz, day, `${clock}:05`);
      expect(
        occurred,
        "the fixture clock must resolve in the profile's zone"
      ).not.toBeNull();
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status, amount)
         VALUES (?, ?, ?, ?, 'taken', '1 serving')`
      ).run(doseId, itemId, day, utcInstant(occurred!));
      logs += 1;
    }
  });
  return logs;
}

test.beforeEach(() => {
  const db = openDb();
  try {
    deleteFixtureRows(db); // idempotent — a failed earlier run leaves no residue
  } finally {
    db.close();
  }
});

test.describe("an active episode page on a phone (#2612)", () => {
  test("the dose caption is one bounded legend line, and the History opens on the illness signal", async ({
    page,
  }) => {
    test.slow();
    const db = openDb();
    let episodeId: number;
    let doseCount: number;
    try {
      const tz = profileTimezone(db);
      const episode = openEpisode(db, tz);
      episodeId = episode.id;
      doseCount = seedRoutineStack(db, episode.days, tz);
    } finally {
      db.close();
    }
    // The fixture is the dilution the issue is about: many more routine doses than
    // the illness rows they are read against.
    expect(doseCount).toBeGreaterThan(6);

    try {
      await page.goto(`/medical/episodes/${episodeId}`);
      const timeline = page.getByTestId("episode-illness-timeline");
      await expect(timeline).toBeVisible();

      // 1. THE LEGEND. Bounded by distinct medication and then by the shared
      // "and N more" tail — never one entry per administration. `summarizeNames`
      // spells three names, so the caption cannot grow past four segments however
      // many doses (or medications) the window holds.
      const caption = page.getByTestId("fever-chart-doses");
      await expect(caption).toBeVisible();
      const captionText = (await caption.innerText()).trim();
      expect(captionText.startsWith("Doses:")).toBe(true);
      expect(captionText.split(",").length).toBeLessThanOrEqual(3);
      // A dose count, not a wall of clocks: no "HH:MM" anywhere in the legend.
      expect(captionText).not.toMatch(/\d{1,2}:\d{2}/);
      expect(captionText).toMatch(/×\d+/);
      // And it costs a couple of lines, not eleven. The old caption wrapped once
      // per ~2.5 doses; this bound holds for any stack size.
      const captionHeight = (await caption.boundingBox())?.height ?? 0;
      expect(captionHeight).toBeGreaterThan(0);
      expect(captionHeight).toBeLessThan(80);

      // 2. THE DEFAULT. The chip strip is rendered and "Illness" leads, because the
      // routine stack outnumbers the symptom + temperature rows.
      const chips = page.getByTestId("illness-history-filters");
      await expect(chips).toBeVisible();
      await expect(
        chips.getByRole("button", { name: "Illness" })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
      // Nothing is REMOVED: every dose row is still in the document, laid out only
      // when the chip asks for it (and still printed — `print:table-row`).
      const doseRows = timeline.locator(
        '[data-testid="illness-event-medication"]'
      );
      expect(await doseRows.count()).toBeGreaterThanOrEqual(doseCount);
      expect(
        await doseRows.evaluateAll((rows) =>
          rows.every((row) => row.getAttribute("data-filtered-out") === "true")
        )
      ).toBe(true);
      // The illness rows the default keeps ARE laid out. Scoped to a day group the
      // phone's own earlier-days fold is not holding back — that fold predates this
      // change and is orthogonal to the chip.
      await expect(
        timeline
          .locator(
            'tbody[data-mobile-earlier="false"] [data-testid="illness-event-symptom"]'
          )
          .first() // first-ok: the assertion is that SOME symptom row is laid out, not which
      ).toBeVisible();

      // 3. THE PRINTED RECORD STAYS COMPLETE. The chip narrows the SCREEN; the
      // episode summary is a doctor-visit artifact, and one that silently dropped
      // the medications given would be a worse defect than a long page. Under print
      // every hidden dose row comes back — the same `print:*` undo the mobile
      // earlier-days fold has always used one level up.
      await page.emulateMedia({ media: "print" });
      expect(
        await doseRows.evaluateAll((rows) =>
          rows.every((row) => getComputedStyle(row).display !== "none")
        )
      ).toBe(true);
      await page.emulateMedia({ media: null });

      // 4. NOTHING BECOMES UNREACHABLE. One tap on "All" brings the ledger back.
      await hydratedClick(page, chips.getByRole("button", { name: "All" }));
      await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(
        timeline
          .locator(
            'tbody[data-mobile-earlier="false"] [data-testid="illness-event-medication"]'
          )
          .first() // first-ok: any dose row in an unfolded day proves the ledger returned
      ).toBeVisible();
    } finally {
      const cleanup = openDb();
      try {
        deleteFixtureRows(cleanup);
      } finally {
        cleanup.close();
      }
    }
  });

  test("a RESOLVED episode is not regressed by the active one's fix — same bounded legend, same reachable ledger", async ({
    page,
  }) => {
    test.slow();
    const db = openDb();
    let episodeId: number;
    let doseCount: number;
    try {
      const tz = profileTimezone(db);
      // A spec-owned CLOSED episode (`end_date` set, #2232's inclusive last active
      // day) far enough back to collide with nothing — the census's resolved case,
      // which already measured 2631px and must stay that way.
      const days = [-210, -209, -208, -207].map((offset) =>
        localDay(tz, offset)
      );
      episodeId = Number(
        db
          .prepare(
            `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
             VALUES (?, ?, ?, ?)`
          )
          .run(PROFILE, RESOLVED_SITUATION, days[0], days.at(-1)!)
          .lastInsertRowid
      );
      for (const day of days) {
        for (const symptom of RESOLVED_SYMPTOMS) {
          db.prepare(
            `INSERT INTO symptom_logs (profile_id, date, symptom, severity, episode_id)
             VALUES (?, ?, ?, 2, ?)`
          ).run(PROFILE, day, symptom, episodeId);
        }
      }
      doseCount = seedRoutineStack(db, days, tz);
    } finally {
      db.close();
    }

    try {
      await page.goto(`/medical/episodes/${episodeId}`);
      const timeline = page.getByTestId("episode-illness-timeline");
      await expect(timeline).toBeVisible();

      // The legend stays bounded on the resolved page too.
      const caption = page.getByTestId("fever-chart-doses");
      await expect(caption).toBeVisible();
      const captionText = (await caption.innerText()).trim();
      expect(captionText).not.toMatch(/\d{1,2}:\d{2}/);
      expect((await caption.boundingBox())?.height ?? 0).toBeLessThan(80);

      // This episode logged NO temperature, so the union chip is not offered at all
      // — the default falls to the narrowest chip that still carries the illness
      // signal, and the strip never shows two chips selecting the same rows.
      const chips = page.getByTestId("illness-history-filters");
      await expect(chips).toBeVisible();
      await expect(chips.getByRole("button", { name: "Illness" })).toHaveCount(
        0
      );
      await expect(
        chips.getByRole("button", { name: "Symptoms" })
      ).toHaveAttribute("aria-pressed", "true");

      // Every dose row is still in the document and one tap away.
      const doseRows = timeline.locator(
        '[data-testid="illness-event-medication"]'
      );
      expect(await doseRows.count()).toBe(doseCount);
      await hydratedClick(page, chips.getByRole("button", { name: "All" }));
      await expect(
        timeline
          .locator(
            'tbody[data-mobile-earlier="false"] [data-testid="illness-event-medication"]'
          )
          .first() // first-ok: any dose row in an unfolded day proves the ledger returned
      ).toBeVisible();
    } finally {
      const cleanup = openDb();
      try {
        deleteFixtureRows(cleanup);
      } finally {
        cleanup.close();
      }
    }
  });
});
