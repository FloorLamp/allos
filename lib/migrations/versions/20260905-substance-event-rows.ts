import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Issue #5026 phase 2 (items 2 and 3): NICOTINE, CANNABIS AND EVERY CUSTOM KEY GET
// THE EVENT LEDGER ALCOHOL ALREADY HAD.
//
// A consumable is an EVENT (owner ruling, 2026-09-04, docs/internals/substances.md).
// Alcohol's units were already `food_log_events` rows carrying `occurred_at` +
// `time_source`; every other substance rode `substance_daily_totals` alone, which is
// UNIQUE per (profile, date, substance) and structurally timeless — so a use was a
// number per day rather than a thing that happened. `substance_log_events` is the
// `food_log_events` shape re-instantiated for that ledger, and nothing else: same
// column names, same semantics, same NULL-means-nobody-said rule. The counter row
// stays exactly where it is, as the cap's substrate and the card's count (the food
// pairing, unchanged since #950).
//
// WHAT IS NOT COPIED, and why: `meal_slot` (a food window has no substance meaning)
// and `notify_message_id` (substance is off the chat vocabulary by reach policy —
// `TELEGRAM_DOMAIN_CENSUS`, docs/internals/substances.md), so a substance tap has no
// originating message to point at. `logged_via` IS, and arrives through the tranche
// shape below rather than inline, so the census can read what shipped.
//
// ── THE FATE OF EVERY ROW LOGGED BEFORE THIS CHANGE ──────────────────────────
//
// This is the decision the change turns on, so it is stated rather than left to be
// inferred from the SQL. A day count of 3 is three uses somebody recorded. After this
// migration the record reads the EVENTS, so a day row with no events behind it counts
// on the card and against the weekly cap while showing nothing in the record — a row
// that is real by one reading and absent by another. That state already exists on the
// alcohol side and is item 3 of this issue (#5085 measures it from the other side).
//
// So a counter row's units ARE events, and where the events are missing this migration
// CREATES them. Both ledgers, one rule:
//
//   • the WHOLE uses `substance_daily_totals` is short, per row;
//   • the WHOLE drinks the alcohol `food_daily_totals` row is short (item 3 — every
//     shipped counter bump since #950 shares its transaction with an event insert, so
//     a shortfall means the row predates that ledger).
//
// Nothing is dropped and NO EVENT TIME IS INVENTED: `occurred_at` and `time_source`
// are NULL on every derived row, which is the honest answer and an answer this app
// already has a name for (`eventInstant` → `not-recorded`, lib/row-instants.ts). A
// derived use therefore draws no chart tick and prints no stated hour, exactly as the
// day row it came from did.
//
// `recorded_at` IS NOT NULL on both ledgers, so a derived row has to carry one, and it
// takes THE DAY ROW'S OWN filing stamp — `substance_daily_totals.recorded_at` (the
// LAST tap's instant) and `food_daily_totals.created_at` (when the day row entered the
// app). The day row remembers exactly one, so all of a day's derived events share it.
// That is a real stored record instant and it is the only one there is; what it does
// NOT claim is that any use HAPPENED then, because `occurred_at` is where that claim
// would live and it is NULL. The visible consequence, said plainly because a reader
// will meet it: a legacy nicotine day that showed one date-only row now shows one row
// per use, each reading "logged HH:MM" off that shared stamp.
//
// Determinism: reads only the DB and its own constants; every derived value comes from
// a column already stored. No clock, no random, no network.
//
// THE BACKFILLS INSERT A SHORTFALL, NOT A COUNT. The runner is name-keyed, so this
// applies once per database — but "insert `units` rows" would double any day that had
// already gained real taps, and the alcohol arm MUST subtract them because that is the
// whole of what item 3 is: the rows that are missing, and only those.

// WHOLE USES, AND WHY THE FLOOR IS SPELLED RATHER THAN ASSUMED. Neither counter column
// is constrained to integers: `food_daily_totals.servings` is REAL NOT NULL (migration
// 030), and `substance_daily_totals.units` is declared INTEGER, which in SQLite is an
// AFFINITY and not a constraint — MEASURED, 0.4 stored into it reads back as 0.4. The
// recursive expansions below stop at `remaining > 1`, so an unfloored fractional
// shortfall would round UP: 0.4 → one event, 1.5 → two, 2.5 → three. That would put a
// use in the record that the counter and the weekly cap never held, which is the one
// thing this migration must not do.
//
// No shipped writer can produce a fraction — every production bump of either counter is
// exactly 1, and undo adds back a captured whole — so against real data this CAST is a
// no-op. It is here because the alternative to a no-op is inventing a use, and a
// migration that writes into every profile's history should carry no branch that can.
// CAST(... AS INTEGER) truncates toward zero, which is the floor for a non-negative
// value, and both columns carry `CHECK (… >= 0)`.
//
// `food_daily_totals.created_at` is the `bare` convention — `YYYY-MM-DD HH:MM:SS`, UTC,
// unstated (docs/internals/time-columns.md) — while `food_log_events.recorded_at` is
// `canonical`. Converting on the way in is what keeps the new rows readable by
// `parseUtcSql` beside every tap-written one; a bare value copied through would sort
// and parse differently from its neighbours.
// The ledger this migration gives `logged_via` (#3087/#4435's tranche shape, and its
// literal list — lib/__tests__/logged-via-census.test.ts unions every tranche's own
// list and holds LEDGERS_WITH_LOGGED_VIA to it). #4435 gave the day COUNTER provenance
// because a nicotine tap was the one user write in the app that could not say which
// surface it came from; once a use is its own row, that answer belongs on the row, the
// shape `food_log_events` already has. Written at creation and never rewritten. Plain
// TEXT, nullable, no default, no CHECK — the vocabulary stays closed in TypeScript
// (lib/logged-via.ts) — and every row the backfill derives reads NULL, which means
// "unknown", honestly: the counter remembers only its LAST tap's surface, so stamping
// it onto each use would be a claim about surfaces nobody recorded.
const TRANCHE = ["substance_log_events"] as const;

const CANONICAL_CREATED_AT = `
  CASE
    WHEN d.created_at LIKE '____-__-__ __:__:__'
      THEN replace(d.created_at, ' ', 'T') || 'Z'
    ELSE d.created_at
  END`;

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS substance_log_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id),
      substance   TEXT NOT NULL,
      date        TEXT NOT NULL,
      -- The tap instant. Canonical by DEFAULT as well as by writer, matching
      -- food_log_events.recorded_at.
      recorded_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      -- The USE instant, nullable: NULL means nobody stated one. time_source records
      -- whether a present value came from a tap contract or from a person saying so --
      -- the same closed pair food_log_events carries.
      occurred_at TEXT,
      time_source TEXT
        CHECK (time_source IS NULL OR time_source IN ('tap', 'stated'))
    );
    CREATE INDEX IF NOT EXISTS idx_substance_log_events_profile
      ON substance_log_events(profile_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_substance_log_events_day
      ON substance_log_events(profile_id, date, substance, recorded_at DESC);
  `);

  for (const table of TRANCHE) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN logged_via TEXT`);
  }

  backfill(db);
}

// THE BACKFILLS, SEPARATE FROM THE SCHEMA STEP SO THEY CAN BE RUN TWICE (review of
// #5290, finding F4). Their idempotence is the whole claim this migration makes about
// replay, and it used to be "asserted" by calling `up` again — which throws
// `duplicate column name: logged_via` at the ALTER above, BEFORE either statement here
// runs, so the assertion held on a migration whose arithmetic had never executed a
// second time. The schema step genuinely is not replayable and does not need to be (the
// runner is name-keyed); the shortfall arithmetic is, and this is the seam that lets a
// test prove it by running it.
export function backfill(db: Database.Database): void {
  // ── The substance ledger's own backfill (item 2) ──────────────────────────
  //
  // One row per outstanding unit. The recursive CTE counts the SHORTFALL between the
  // day's `units` and the events already standing for it, so a replay adds nothing and
  // a day that has since gained real taps is topped up rather than doubled.
  db.exec(`
    WITH shortfall AS (
      SELECT t.id, t.profile_id, t.substance, t.date, t.recorded_at,
             CAST(t.units - (
               SELECT COUNT(*) FROM substance_log_events e
                WHERE e.profile_id = t.profile_id
                  AND e.date = t.date
                  AND e.substance = t.substance
             ) AS INTEGER) AS missing
        FROM substance_daily_totals t
    ),
    expanded(id, profile_id, substance, date, recorded_at, remaining) AS (
      SELECT id, profile_id, substance, date, recorded_at, missing
        FROM shortfall WHERE missing > 0
      UNION ALL
      SELECT id, profile_id, substance, date, recorded_at, remaining - 1
        FROM expanded WHERE remaining > 1
    )
    INSERT INTO substance_log_events
      (profile_id, substance, date, recorded_at, occurred_at, time_source, logged_via)
    SELECT profile_id, substance, date, recorded_at, NULL, NULL, NULL FROM expanded;
  `);

  // ── The orphan alcohol day (item 3) ───────────────────────────────────────
  //
  // The same rule on the other ledger, scoped to the alcohol group because that is the
  // group whose counter and record disagree: the substance card counts it and the
  // weekly cap counts it, and since 2026-09-04 the record reads the events instead.
  // Deliberately NOT widened to every food group — a non-alcohol shortfall is the same
  // shape but a different surface's question, and this issue owns the substance one.
  db.exec(`
    WITH shortfall AS (
      SELECT d.id, d.profile_id, d.date,
             ${CANONICAL_CREATED_AT} AS stamp,
             CAST(d.servings - (
               SELECT COUNT(*) FROM food_log_events e
                WHERE e.profile_id = d.profile_id
                  AND e.date = d.date
                  AND e.group_key = 'alcohol'
             ) AS INTEGER) AS missing
        FROM food_daily_totals d
       WHERE d.group_key = 'alcohol'
    ),
    expanded(profile_id, date, stamp, remaining) AS (
      SELECT profile_id, date, stamp, missing FROM shortfall WHERE missing > 0
      UNION ALL
      SELECT profile_id, date, stamp, remaining - 1
        FROM expanded WHERE remaining > 1
    )
    INSERT INTO food_log_events
      (profile_id, group_key, date, recorded_at, occurred_at, time_source)
    SELECT profile_id, 'alcohol', date, stamp, NULL, NULL FROM expanded;
  `);

  rewriteTrashedDays(db);
}

// ── The third place a day row lives: the trash (fourth falsifying pass of #5290) ──
//
// A `substance-history` capture taken before this migration has ONE entity — the
// counter row — because there was no use ledger under it to capture. `restoreDeletedRow`
// reads `payload.rows[entity.entity] ?? []` (lib/undo-delete-db.ts), so the entity an old
// capture lacks restores as NOTHING and raises nothing: Data → Trash would hand back a
// counter of 3 with an empty record — the state the header above says this migration
// exists to remove — manufactured AFTER it ran, through a shipped door. Trash retention
// is 30 days (DEFAULT_TRASH_RETENTION_DAYS), so every capture taken in the month before
// the deploy is live at deploy time. So the stored snapshots are rewritten in the same
// one-shot move, exactly as 183-food-event-occurred-at did for the food ledger's rename.
//
// This serves BOTH restore arms, because both read the same `rows.events`: the plain
// re-insert, and the merge arm that folds a capture into a day row re-taken since the
// capture (mergeRecreatedSubstanceHistoryRoot) — which adds the captured `units` back to
// the live counter and would otherwise add no uses beside them.
//
// The payload already carries everything a derived use needs: the captured counter's own
// `units` and `recorded_at`, which is exactly what the live arm above derives from. The
// same rules hold — whole uses only, and no invented `occurred_at`.
//
// `substance-alcohol-history` is deliberately untouched: its `events` entity is on `main`,
// so its captures are complete and nothing here adds an entity to them.
//
// THIS ARM IS FOR THE DEPLOY WINDOW, AND ON MOST DATABASES IT MATCHES NOTHING — said
// plainly because a reader who goes looking for the rows it fixed will find none. The
// production census taken the evening this shipped (2026-09-05 23:00Z) held ZERO live
// pre-upgrade `substance-history` captures, so this is not repair of data that exists;
// it is the guarantee that a capture taken by the PREVIOUS build, at any point in the
// 30-day retention window that straddles the deploy, restores as a counter WITH its
// uses. Its correctness therefore rests on the reproduction in
// lib/__db_tests__/substance-use.test.ts (a stripped capture, this backfill, then a
// Trash restore) and on its idempotence, not on any row in production. On a database
// with no such capture it is a no-op, which is the expected outcome.
function rewriteTrashedDays(db: Database.Database): void {
  const hasTrash = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleted_rows'`
    )
    .get();
  if (!hasTrash) return;
  const update = db.prepare(`UPDATE deleted_rows SET payload = ? WHERE id = ?`);
  const rows = db
    .prepare(`SELECT id, payload FROM deleted_rows WHERE kind = ?`)
    .all("substance-history") as { id: number; payload: string }[];
  for (const row of rows) {
    if (typeof row.payload !== "string") continue;
    const next = withDerivedUses(row.payload);
    if (next !== null) update.run(next, row.id);
  }
}

// One stored payload, rewritten — or null when there is nothing to do. IDEMPOTENT BY
// CONSTRUCTION: the entity KEY's presence is the discriminator, so a payload this has
// already rewritten and every capture taken after the deploy are both skipped, and the
// key is set even when it derives nothing (a zero-unit day carrying only a note) so the
// second run has the same thing to look at as the first.
function withDerivedUses(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A payload that does not parse is already unrestorable; leave it exactly as found
    // rather than making this migration the thing that lost it (183's rule).
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rows = (parsed as { rows?: unknown }).rows;
  if (!rows || typeof rows !== "object") return null;
  const bag = rows as Record<string, unknown>;
  if ("events" in bag) return null;
  const captured = bag.entry;
  if (!Array.isArray(captured)) return null;

  const derived: Record<string, unknown>[] = [];
  for (const entry of captured) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.profile_id !== "number" ||
      typeof row.substance !== "string" ||
      typeof row.date !== "string" ||
      typeof row.recorded_at !== "string" ||
      typeof row.units !== "number"
    )
      continue;
    // WHOLE uses, the CAST(... AS INTEGER) of the live arm in JavaScript: the column's
    // CHECK is `units >= 0`, so flooring is that truncation. Rounding up would restore a
    // use the counter never held.
    for (let i = Math.floor(row.units); i > 0; i--)
      derived.push({
        profile_id: row.profile_id,
        substance: row.substance,
        date: row.date,
        recorded_at: row.recorded_at,
        occurred_at: null,
        time_source: null,
        logged_via: null,
      });
  }
  bag.events = derived;
  return JSON.stringify(parsed);
}

export const migration: Migration = {
  name: "20260905-substance-event-rows",
  up,
};
