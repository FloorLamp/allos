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
// Three claims, all MEASURED rather than eyeballed:
//   1. The dose caption under the History chart is bounded by DISTINCT medication,
//      not by dose. It used to render one timestamped entry per administration —
//      the same rows the per-day table below carries verbatim — so the page paid
//      that height twice.
//   2. When the routine SUPPLEMENT stack would outnumber everything else, the
//      History opens on the Illness chip, which hides those dose rows — they stay
//      in the document, print, and return on one tap.
//   3. What it hides is the supplement stack and ONLY that. The medicine given for
//      the illness stays on screen: a 200 mg ibuprofen during a fever is the row a
//      reader came for, and an Illness view that dropped it would have thrown the
//      care out with the noise.
//
// The resolved case must not regress while the active one is fixed, so the second
// test builds its own CLOSED episode and asserts the same properties there.
//
// FIXTURE (#868 hygiene): the spec owns every row it asserts on — uniquely-named
// routine supplements AND one uniquely-named PRN medication with their
// administrations, and (for the resolved case) its own episode row and symptom
// logs. All of it is deleted in `beforeEach` and again in a `finally`, and nothing
// from the shared seed is exact-counted. Dose instants go through
// `zonedWallTimeToUtc` on the profile's own timezone (#1417): the episode groups
// its ledger by profile-LOCAL day, so a naive zoneless string would file doses on
// the wrong day in any non-UTC zone.

// Uniquely-named routine stack: `may`-obligation SUPPLEMENTS, which is what the
// episode assembly gathers and what a real profile's daily stack is filed as.
const STACK = [
  "E2e Fold Creatine",
  "E2e Fold Whey",
  "E2e Fold Iron",
  "E2e Fold Calcium",
  "E2e Fold Magnesium",
  "E2e Fold Zinc",
];
// The illness's own medicine — same table, same `may` obligation, different KIND.
// This is the row the Illness view must keep.
const MEDICINE = "E2e Fold Ibuprofen";
const MEDICINE_AMOUNT = "200 mg";
const FIXTURE_ITEMS = [...STACK, MEDICINE];
const PROFILE = 1;
// The spec's own CLOSED episodes, far enough back that they cannot collide with a
// seeded day (symptom_logs is UNIQUE on profile+date+symptom). Two of them, so the
// two branches of the default decision each get exact, spec-owned counts instead of
// depending on how symptom-rich the shared seed's live episode happens to be.
const OWNED_SITUATIONS = [
  "E2e Fold Diluted Illness",
  "E2e Fold Resolved Illness",
];
const [DILUTED_SITUATION, RESOLVED_SITUATION] = OWNED_SITUATIONS;
const RESOLVED_SYMPTOMS = ["e2e-fold-ache", "e2e-fold-cough"];
// A temperature marker only this spec writes, so its rows are removable by value.
const OWNED_TEMP_NOTE = "e2e-fold-fixture";

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function deleteFixtureRows(db: Database.Database): void {
  const names = FIXTURE_ITEMS.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = ? AND name IN (${names}))`
  ).run(PROFILE, ...FIXTURE_ITEMS);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name IN (${names})`
  ).run(PROFILE, ...FIXTURE_ITEMS);
  db.prepare(
    `DELETE FROM symptom_logs WHERE profile_id = ? AND symptom IN (?, ?)`
  ).run(PROFILE, ...RESOLVED_SYMPTOMS);
  db.prepare(
    `DELETE FROM medical_records WHERE profile_id = ? AND notes = ?`
  ).run(PROFILE, OWNED_TEMP_NOTE);
  db.prepare(
    `DELETE FROM illness_episodes WHERE profile_id = ? AND situation IN (?, ?)`
  ).run(PROFILE, ...OWNED_SITUATIONS);
}

// A spec-owned illness window: its own closed episode row, its own symptom days,
// optionally its own temperature readings, its own routine supplement stack and its
// own PRN medicine. Every count below is therefore EXACT — the default decision is
// a comparison between two row counts, so a fixture that borrowed the shared seed's
// symptom-rich live episode would be asserting on a number it does not control.
function seedOwnedEpisode(
  db: Database.Database,
  opts: {
    situation: string;
    tz: string;
    firstOffset: number;
    dayCount: number;
    withTemperature: boolean;
  }
): {
  episodeId: number;
  days: string[];
  symptomRows: number;
  temperatureRows: number;
  supplementLogs: number;
  medicineLogs: number;
} {
  const days = Array.from({ length: opts.dayCount }, (_, index) =>
    localDay(opts.tz, opts.firstOffset + index)
  );
  const episodeId = Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, ?, ?, ?)`
      )
      .run(PROFILE, opts.situation, days[0], days.at(-1)!).lastInsertRowid
  );
  let symptomRows = 0;
  let temperatureRows = 0;
  for (const day of days) {
    for (const symptom of RESOLVED_SYMPTOMS) {
      db.prepare(
        `INSERT INTO symptom_logs (profile_id, date, symptom, severity, episode_id)
         VALUES (?, ?, ?, 2, ?)`
      ).run(PROFILE, day, symptom, episodeId);
      symptomRows += 1;
    }
    if (!opts.withTemperature) continue;
    const taken = zonedWallTimeToUtc(opts.tz, day, "08:00");
    expect(taken, "the fixture clock must resolve in the profile's zone").not
      .toBeNull();
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit,
          canonical_name, source, occurred_at, notes)
       VALUES (?, ?, 'vitals', 'Body Temperature', '101.2', 101.2, 'degF',
               'Body Temperature', 'manual', ?, ?)`
    ).run(PROFILE, day, utcInstant(taken!), OWNED_TEMP_NOTE);
    temperatureRows += 1;
  }
  const { supplementLogs, medicineLogs } = seedRoutineStack(db, days, opts.tz);
  return {
    episodeId,
    days,
    symptomRows,
    temperatureRows,
    supplementLogs,
    medicineLogs,
  };
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

// One dose of `name` per episode day, at a stated administration instant on the
// profile's own clock (#1417). Returns how many logs were written.
function seedDailyIntake(
  db: Database.Database,
  opts: {
    name: string;
    kind: "supplement" | "medication";
    amount: string;
    hour: number;
    days: string[];
    tz: string;
  }
): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, ?, 'daily', 'may')`
      )
      .run(PROFILE, opts.name, opts.kind).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, ?, 'anytime', 'any', 0)`
      )
      .run(itemId, opts.amount).lastInsertRowid
  );
  for (const day of opts.days) {
    const occurred = zonedWallTimeToUtc(
      opts.tz,
      day,
      `${`0${opts.hour}`.slice(-2)}:05`
    );
    expect(
      occurred,
      "the fixture clock must resolve in the profile's zone"
    ).not.toBeNull();
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status, amount)
       VALUES (?, ?, ?, ?, 'taken', ?)`
    ).run(doseId, itemId, day, utcInstant(occurred!), opts.amount);
  }
  return opts.days.length;
}

// The census's shape, with both halves of the split present: an ordinary daily
// SUPPLEMENT stack filling the window, plus the illness's own PRN MEDICATION. The
// two are identical in every respect the assembly cares about except `kind` — same
// table, same `may` obligation, same window — which is exactly what makes the
// medicine's survival a real assertion rather than an artefact of the fixture.
function seedRoutineStack(
  db: Database.Database,
  days: string[],
  tz: string
): { supplementLogs: number; medicineLogs: number } {
  let supplementLogs = 0;
  STACK.forEach((name, index) => {
    supplementLogs += seedDailyIntake(db, {
      name,
      kind: "supplement",
      amount: "1 serving",
      hour: 7 + index,
      days,
      tz,
    });
  });
  const medicineLogs = seedDailyIntake(db, {
    name: MEDICINE,
    kind: "medication",
    amount: MEDICINE_AMOUNT,
    hour: 19,
    days,
    tz,
  });
  return { supplementLogs, medicineLogs };
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
  test("the dose caption under the History chart is one bounded legend line", async ({
    page,
  }) => {
    test.slow();
    const db = openDb();
    let episodeId: number;
    let supplementLogs: number;
    let medicineLogs: number;
    try {
      const tz = profileTimezone(db);
      // The seed's LIVE episode, given the census's routine stack. The active page
      // is where the 4556px was measured, so the legend claim is asserted on it.
      const episode = openEpisode(db, tz);
      episodeId = episode.id;
      ({ supplementLogs, medicineLogs } = seedRoutineStack(
        db,
        episode.days,
        tz
      ));
    } finally {
      db.close();
    }
    expect(supplementLogs).toBeGreaterThan(6);
    expect(medicineLogs).toBeGreaterThan(0);

    try {
      await page.goto(`/medical/episodes/${episodeId}`);
      await expect(page.getByTestId("episode-illness-timeline")).toBeVisible();

      // Bounded by DISTINCT medication and then by the shared "and N more" tail —
      // never one entry per administration. `summarizeNames` spells three names, so
      // the caption cannot grow past four segments however many doses (or
      // medications) the window holds.
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
    } finally {
      const cleanup = openDb();
      try {
        deleteFixtureRows(cleanup);
      } finally {
        cleanup.close();
      }
    }
  });

  test("the Illness view hides the routine stack, keeps the medicine, and prints in full", async ({
    page,
  }) => {
    test.slow();
    const db = openDb();
    let seeded: ReturnType<typeof seedOwnedEpisode>;
    try {
      // EXACT counts, all spec-owned: 4 days × (2 symptoms + 1 temperature + 1
      // ibuprofen + 6 supplements). Shown = 8 + 4 + 4 = 16, hidden = 24, so the
      // Illness view earns the lead by hiding more than it leaves. Borrowing the
      // shared seed's live episode here would make the comparison depend on how
      // symptom-rich that fixture happens to be, which is not this spec's to know.
      seeded = seedOwnedEpisode(db, {
        situation: DILUTED_SITUATION,
        tz: profileTimezone(db),
        firstOffset: -220,
        dayCount: 4,
        withTemperature: true,
      });
    } finally {
      db.close();
    }
    const shown =
      seeded.symptomRows + seeded.temperatureRows + seeded.medicineLogs;
    expect(seeded.supplementLogs).toBeGreaterThan(shown);

    try {
      await page.goto(`/medical/episodes/${seeded.episodeId}`);
      const timeline = page.getByTestId("episode-illness-timeline");
      await expect(timeline).toBeVisible();

      // 1. THE DEFAULT. The strip renders and "Illness" leads.
      const chips = page.getByTestId("illness-history-filters");
      await expect(chips).toBeVisible();
      await expect(
        chips.getByRole("button", { name: "Illness" })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
        "aria-pressed",
        "false"
      );

      // 2. HIDDEN IS NOT REMOVED. Every dose row of both kinds is in the document;
      // the chip decides only what is LAID OUT.
      const doseRows = timeline.locator(
        '[data-testid="illness-event-medication"]'
      );
      expect(await doseRows.count()).toBe(
        seeded.supplementLogs + seeded.medicineLogs
      );
      const hiddenByChip = await doseRows.evaluateAll((rows) =>
        rows
          .filter((row) => row.getAttribute("data-filtered-out") === "true")
          .map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "")
      );

      // 3. WHAT IT HIDES IS THE STACK, AND ONLY THE STACK. Every hidden row is a
      // supplement and the ibuprofen is not among them. This is the assertion the
      // whole `kind` split exists for: an Illness view that dropped the medicine
      // given for the illness would have thrown out the most important row on the
      // page along with the noise.
      expect(hiddenByChip.length).toBe(seeded.supplementLogs);
      expect(hiddenByChip.filter((text) => text.includes(MEDICINE))).toEqual([]);
      // The medicine is not merely present — it is on screen, in a day group the
      // phone's own earlier-days fold is not holding back (that fold predates this
      // change and is orthogonal to the chip).
      const unfolded = 'tbody[data-mobile-earlier="false"] ';
      const laidOutMedicine = timeline
        .locator(`${unfolded}[data-testid="illness-event-medication"]`)
        .filter({ hasText: MEDICINE });
      await expect(
        laidOutMedicine.first() // first-ok: one laid-out ibuprofen row proves the medicine survives the default
      ).toBeVisible();
      await expect(
        timeline
          .locator(`${unfolded}[data-testid="illness-event-symptom"]`)
          .first() // first-ok: the assertion is that SOME symptom row is laid out, not which
      ).toBeVisible();
      await expect(
        timeline
          .locator(`${unfolded}[data-testid="illness-event-temperature"]`)
          .first() // first-ok: same — the temperature half of the illness signal is laid out
      ).toBeVisible();

      // 4. THE PRINTED RECORD STAYS COMPLETE. The chip narrows the SCREEN; the
      // episode summary is a doctor-visit artifact, and one that silently dropped
      // any dose given would be a worse defect than a long page. Under print every
      // hidden row comes back — the same `print:*` undo the mobile earlier-days
      // fold has always used one level up.
      await page.emulateMedia({ media: "print" });
      expect(
        await doseRows.evaluateAll((rows) =>
          rows.every((row) => getComputedStyle(row).display !== "none")
        )
      ).toBe(true);
      await page.emulateMedia({ media: null });

      // 5. NOTHING BECOMES UNREACHABLE. One tap on "All" lays the stack back out.
      await hydratedClick(page, chips.getByRole("button", { name: "All" }));
      await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(
        timeline
          .locator(`${unfolded}[data-testid="illness-event-medication"]`)
          .filter({ hasText: STACK[0] })
          .first() // first-ok: a stack row back in the layout proves the tap restored it
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

  test("an episode with no temperature never narrows — Symptoms alone would hide the medicine", async ({
    page,
  }) => {
    test.slow();
    const db = openDb();
    let seeded: ReturnType<typeof seedOwnedEpisode>;
    try {
      // The same dilution, minus the temperature half, so the union chip cannot be
      // offered. There is deliberately NO single-chip fallback: narrowing to
      // "Symptoms" would drop every dose row including the ibuprofen, which is the
      // exact mistake the kind split exists to avoid. The page keeps the legend's
      // height win and nothing else — the conservative half of #2612.
      seeded = seedOwnedEpisode(db, {
        situation: RESOLVED_SITUATION,
        tz: profileTimezone(db),
        firstOffset: -210,
        dayCount: 4,
        withTemperature: false,
      });
    } finally {
      db.close();
    }

    try {
      await page.goto(`/medical/episodes/${seeded.episodeId}`);
      const timeline = page.getByTestId("episode-illness-timeline");
      await expect(timeline).toBeVisible();

      // The legend stays bounded on a resolved page too.
      const caption = page.getByTestId("fever-chart-doses");
      await expect(caption).toBeVisible();
      expect((await caption.innerText()).trim()).not.toMatch(/\d{1,2}:\d{2}/);
      expect((await caption.boundingBox())?.height ?? 0).toBeLessThan(80);

      const chips = page.getByTestId("illness-history-filters");
      await expect(chips).toBeVisible();
      await expect(chips.getByRole("button", { name: "Illness" })).toHaveCount(
        0
      );
      await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );

      // So every dose row — stack and medicine alike — is laid out, exactly as it
      // was before this change. The resolved page the census measured at 2631px is
      // untouched.
      const doseRows = timeline.locator(
        '[data-testid="illness-event-medication"]'
      );
      expect(await doseRows.count()).toBe(
        seeded.supplementLogs + seeded.medicineLogs
      );
      expect(
        await doseRows.evaluateAll((rows) =>
          rows.every((row) => row.getAttribute("data-filtered-out") === "false")
        )
      ).toBe(true);
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
