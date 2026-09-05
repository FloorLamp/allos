import Database from "better-sqlite3";
import fs from "node:fs";
import { shiftDateStr } from "@/lib/date";
import { workerDbPath } from "./worker-env";

// THE STANDING SHARED-FIXTURE GUARD (issue #3173).
//
// No spec may leave a LIVE WORKOUT DRAFT on the shared admin profile. #3163 is why:
// `offline-refused-capture.spec.ts` left a started, unended activity on profile 1,
// `getWorkoutPresence` read it as an ACTIVE workout, and the app-wide WorkoutDock
// then haunted every later spec on that worker. The only thing that ever noticed was
// `offline-set-log`'s closing `expect(workout-dock).toHaveCount(0)` — and only once a
// shard reshuffle happened to seat the two files together. Two innocent clusters
// (#3144, #3165) each got a red on a spec they had not touched and each had every
// reason to suspect their own diff first. #3169 fixed the one instance; this stops
// the next one.
//
// It hangs off an auto TEST-scoped fixture (e2e/fixtures.ts), not a global teardown,
// because the whole point is to name the test that CAUSED the leak rather than the
// unlucky neighbour that notices three specs later. A global teardown could only
// name the run.
//
// THAT ATTRIBUTION IS BEST-EFFORT, AND THE GAP IS MEASURED (#4788, confirmed under
// #5037). A Server Action does not stop when its browser context does: a probe that
// filled the measurements form, waited only for the POST to LEAVE the browser, then
// closed the context, saw the row land 61 ms, 106 ms and 76 ms AFTER
// `context.close()` returned, in three consecutive runs on this suite's own
// harness. The guard's reading happens right after that close, so a write still in
// flight when a test ends is not attributed to it — and it is not attributed to
// anyone: it lands in the NEXT test's `before` snapshot and is thereafter invisible.
// Closing the context is NOT evidence that the server drained.
//
// In practice a test that ends with an assertion on its own save has already waited
// for the response, so the window is open only for an action nothing awaited. What
// this guard therefore promises is: every leak it REPORTS belongs to the test it
// names. It does not promise to see every leak.
//
// PROFILE 1 ONLY, deliberately. A spec that legitimately needs a live draft gives it
// a profile of its own and disposes of it — the fixture-ownership rule (#868, #3029,
// #3040, #3106) — and the seeded ones already do: the `Push day` draft the workout
// dock hydrates from lives on the dedicated PRESENCE_PROFILE, so it is exempt by
// construction rather than by an allowlist that would rot. Profile 1 is the one
// profile every spec shares, so it is the one where a leak becomes somebody else's
// failure.

/** The profile every "shared fixture" spec acts as — the bootstrap admin's. */
export const SHARED_PROFILE_ID = 1;

export interface StrandedDraft {
  id: number;
  title: string;
  date: string;
}

export type DraftAssertionScope =
  | { kind: "shared"; profileId: typeof SHARED_PROFILE_ID }
  | {
      kind: "spec-owned";
      profileId: number;
      profileName: string;
      ownerLogin: string;
    };

/** The standing guard's explicit permission to repair profile 1. */
export const SHARED_PROFILE_DRAFT_SCOPE: DraftAssertionScope = {
  kind: "shared",
  profileId: SHARED_PROFILE_ID,
};

// The LIVE-DRAFT SIGNATURE, straight off `computeWorkoutPresence`'s own `active`
// classifier (lib/workout-presence.ts): a manual (source-less) row that started, has
// no end, and carries no positive duration. Those four columns are exactly what the
// presence loop tests — `source` skips imports, `isCompletedSessionRow` covers the
// other three — so this selects the shape that resurrects the dock and nothing else.
// A finished session, an untimed retroactive log and an import all fail it.
const LIVE_DRAFT_SQL = `SELECT id, title, date
     FROM activities
    WHERE profile_id = ?
      AND source IS NULL
      AND start_time IS NOT NULL
      AND end_time IS NULL
      AND (duration_min IS NULL OR duration_min <= 0)
    ORDER BY id`;

/**
 * READ the live drafts on `profileId` without touching them — the same four columns
 * `takeStrandedDrafts` repairs on, asked as a question instead of a repair.
 *
 * IT EXISTS FOR THE ASSERTION THAT CANNOT BE MADE IN THE DOM (#3441). A live session
 * that races its own create ends up with TWO rows, and the editor is looking at
 * exactly one of them: every on-screen assertion — the panel, the dock, the delete,
 * the toast — is GREEN about the row it holds while the other stands alone in the
 * log. So the witness has to count rows, and it has to count them WITHOUT the
 * repairing side effect, or the count would erase the evidence it just took.
 */
export function listLiveDrafts(
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): StrandedDraft[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    return db.prepare(LIVE_DRAFT_SQL).all(profileId) as StrandedDraft[];
  } finally {
    db.close();
  }
}

/**
 * Find every live draft stranded on `profileId` in `dbPath`, DELETE it, and return
 * what was found. Defaults to the shared profile, which is the standing guard's job.
 *
 * It repairs as well as reports on purpose. A detector that only reported would leave
 * the draft in place, so the next test on that worker fails too, and the one after
 * that — a cascade whose first red is the culprit and whose remaining reds are noise
 * burying it. Removing the row means exactly ONE test fails: the one that caused it.
 * (The delete rides the schema's own `ON DELETE CASCADE` from `exercise_sets` and the
 * other activity-owned tables, which is why `foreign_keys` is turned on for it.)
 *
 * `profileId` EXISTS SO THE SIGNATURE ABOVE STAYS SINGLE-SOURCED (#3290). A spec that
 * drives a live workout on a DEDICATED fixture profile is outside the standing guard
 * by design, so it has to prove its own cleanup — and the only honest way to do that
 * is to ask the same four columns `computeWorkoutPresence` asks. Re-spelling
 * `LIVE_DRAFT_SQL` at that call site would mean two definitions of "an active
 * workout" that drift apart the first time the presence classifier changes.
 */
export function takeStrandedDrafts(
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): StrandedDraft[] {
  // A worker whose database was never created (a fixture that failed before the
  // template copy) has nothing to answer for.
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const stranded = db
      .prepare(LIVE_DRAFT_SQL)
      .all(profileId) as StrandedDraft[];
    if (stranded.length > 0) {
      const drop = db.prepare(
        "DELETE FROM activities WHERE id = ? AND profile_id = ?"
      );
      for (const row of stranded) drop.run(row.id, profileId);
    }
    return stranded;
  } finally {
    db.close();
  }
}

/** The failure message a stranded draft earns, naming the rows it left behind. */
export function strandedDraftMessage(
  stranded: StrandedDraft[],
  profileId: number = SHARED_PROFILE_ID,
  profileName?: string
): string {
  const rows = stranded
    .map((row) => `  • activity ${row.id} "${row.title}" (${row.date})`)
    .join("\n");
  const which =
    profileId === SHARED_PROFILE_ID
      ? `the SHARED profile ${SHARED_PROFILE_ID}`
      : profileName
        ? `its own fixture profile "${profileName}" (profile ${profileId})`
        : `its own fixture profile ${profileId}`;
  return (
    `This test left ${stranded.length} live workout draft(s) on ` +
    `${which} (#3173):\n${rows}\n\n` +
    `A started-but-unended manual activity is what getWorkoutPresence reads as an ` +
    `ACTIVE workout, so the app-wide workout dock would haunt every later spec on ` +
    `this worker and fail one of them instead of this one (#3163).\n\n` +
    `Dispose of the draft in this test — from a \`finally\`, so an earlier failure ` +
    `cannot skip it — or give the fixture a profile of its own (#868). The rows above ` +
    `have been removed so the rest of this worker's run is unaffected.`
  );
}

/**
 * Repair and ASSERT the absence of a live draft at a spec cleanup boundary.
 *
 * A sweep is safe only in one of two scopes: profile 1, whose automatic per-test
 * guard serialises ownership, or a fixture profile the calling spec owns outright.
 * The latter has no numeric shortcut: the caller must declare the profile's stable
 * name and owner login. The helper checks both the name and that this is the only
 * login granted to the profile before deleting anything; e2e-hygiene independently
 * proves that only the declaring spec signs in as that login. That makes a copy onto
 * somebody else's fixture fail at the precondition instead of quietly erasing its
 * rows. The assertion lives here with the live-draft signature so every caller both
 * reports and repairs the same condition.
 */
export function assertNoStrandedDrafts(
  dbPath: string = workerDbPath(),
  scope: DraftAssertionScope = SHARED_PROFILE_DRAFT_SCOPE
): void {
  if (!fs.existsSync(dbPath)) return;

  if (scope.kind === "shared") {
    if (scope.profileId !== SHARED_PROFILE_ID)
      throw new Error(
        `The shared-profile draft scope must name profile ${SHARED_PROFILE_ID}.`
      );
  } else {
    if (scope.profileId === SHARED_PROFILE_ID)
      throw new Error(
        `Profile ${SHARED_PROFILE_ID} is shared; it cannot be declared spec-owned.`
      );
    const db = new Database(dbPath, { readonly: true });
    try {
      db.pragma("busy_timeout = 5000");
      const actual = db
        .prepare("SELECT name FROM profiles WHERE id = ?")
        .get(scope.profileId) as { name: string } | undefined;
      if (actual?.name !== scope.profileName)
        throw new Error(
          `Draft assertion expected owned fixture profile ${scope.profileId} to be ` +
            `"${scope.profileName}", but found ${actual ? `"${actual.name}"` : "no profile"}.`
        );
      const grants = db
        .prepare(
          `SELECT l.username, lp.access
             FROM login_profiles lp
             JOIN logins l ON l.id = lp.login_id
            WHERE lp.profile_id = ?
            ORDER BY l.username`
        )
        .all(scope.profileId) as Array<{ username: string; access: string }>;
      if (
        grants.length !== 1 ||
        grants[0].username !== scope.ownerLogin ||
        grants[0].access !== "write"
      )
        throw new Error(
          `Owned fixture profile ${scope.profileId} is not exclusively granted with ` +
            `write access to ${scope.ownerLogin}; found ` +
            `${grants.map((grant) => `${grant.username}:${grant.access}`).join(", ") || "no grants"}.`
        );
    } finally {
      db.close();
    }
  }

  const stranded = takeStrandedDrafts(dbPath, scope.profileId);
  if (stranded.length > 0)
    throw new Error(
      strandedDraftMessage(
        stranded,
        scope.profileId,
        scope.kind === "spec-owned" ? scope.profileName : undefined
      )
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND THING THIS GUARD LOOKS AT: A SAVED ROW THAT OUTLIVES ITS TEST
// (issue #3946).
//
// #3930 was the same defect one level down. `autosave-retry.spec.ts` saved a
// today-dated cardio activity on profile 1 and never deleted it;
// `analyzeQuickLinks` (lib/analyze-view.ts) gives each kind exactly ONE guaranteed
// slot, filled by that kind's MOST RECENT item, so the stranded `Running` pushed
// the seeded `Cycling` out of the strip for every later test in the same worker.
// With `fullyParallel: true` and two workers per shard, whether that happened was
// a per-run coin flip: nine consecutive merges alternated red on `e2e-main (3)`.
// Seven other specs that create an activity on profile 1 already delete it by
// hand; the eighth did not, which is a convention with no mechanism.
//
// THREE THINGS SHAPE IT, and each one is a way the obvious version would be wrong.
//
// 1. IT IS A DIFF, NOT A PRESENCE CHECK. "A row exists" is not the defect —
//    `trash` and `undo-delete` legitimately create and destroy rows mid-test, and
//    every spec runs against a database full of seeded rows. The defect is that
//    profile 1's derived surfaces MOVED AND STAYED MOVED, so the signal is the
//    per-test difference between two readings of the same query. Both readings are
//    taken in the `auto` fixture slot the draft guard already occupies, which is
//    what lets the failure name the test that leaked rather than the run.
//    It looks in BOTH directions on purpose: a spec that deletes or re-dates a
//    SEEDED row breaks the same neighbour just as thoroughly as one that adds a row.
//
//    AND IT IS KEYED ON WHAT A LATER TEST CAN SEE, NOT ON ROW IDENTITY — measured,
//    not assumed. The first version keyed the diff on `activities.id` and reported
//    `training-log-merge` for merging two rows and then UNDOING it: the undo
//    re-creates the discarded row with a NEW id, which an id-keyed diff calls one
//    deletion plus one insertion while a reader of the Log sees exactly what it saw
//    before. So a snapshot is a MULTISET of the fields the surfaces actually consume,
//    and a row that comes back identical is correctly silent.
//
// 2. IT IS DATE-SCOPED, AND THE SCOPE IS MEASURED FROM THE FROZEN INSTANT. What
//    broke ride-detail was a row dated TODAY on a surface ranked by recency;
//    `palette-deeplinks`' 2019-dated insert is inert and always was. Scoping to the
//    recency horizon catches the real class at a fraction of the noise. The horizon
//    MUST come from the run's frozen instant and never from the wall clock — a
//    guard whose behaviour depends on when CI happens to run is the same defect it
//    exists to catch.
//
// 3. A SPEC DECLARES ITS LEAVERS; THERE IS NO LIST OF EXEMPT SPEC NAMES. Some rows
//    are meant to outlive their test. An allowlist keyed on spec name is the
//    forbidden shape: it rots silently and it exempts the whole file including the
//    leak nobody meant. Instead a spec says, in its own source, which rows it
//    leaves and why — `test.use({ sharedProfileLeftovers: { why, rows } })`.
//
//    THE `why` IS REQUIRED AND ITS TRUTH IS STILL UNCHECKED — #3260's caveat stands
//    and this does not answer it. What IS checked is whether the declaration is still
//    NEEDED: a handle declared that the test does not actually leave is reported as
//    STALE. That is the half that rots first — a cleanup gets added, or a fixture
//    moves, and the exemption goes on silently covering nothing — and it costs one
//    comparison over a set the diff already computed. It does not, and must not be
//    claimed to, tell you whether a live declaration's stated reason is true.
//
//    WHAT THE DIFF DOES *NOT* WATCH, and why: `duration_min` and the other numeric
//    columns. The subject is what a LATER TEST can see, and the surfaces rank on
//    `lastDate` and key on kind + item — a duration edit re-ranks nothing. Watching
//    numbers would red every in-place edit in the suite to buy a defect nobody has.
/**
 * How far back a later spec can still be moved by profile 1's activities, IN DAYS.
 *
 * It is 84 because that is `RANGES` "12w" in lib/analyze-view.ts — the range
 * `coerceRange` falls back to, and therefore the window Training → Analyze reads
 * when no one has chosen otherwise. That is the surface #3930 broke, so its default
 * window is the honest bound: a row older than this cannot enter the quick-link
 * strip a later test looks at, and watching it would only buy noise.
 */
export const SHARED_RECENCY_HORIZON_DAYS = 84;

/** The oldest day inside a `days`-wide window, measured from the FROZEN instant. */
export function horizonStart(now: Date, days: number): string {
  return shiftDateStr(now.toISOString().slice(0, 10), -days);
}

/** The oldest day inside the ACTIVITY horizon. */
export function recencyHorizonStart(now: Date): string {
  return horizonStart(now, SHARED_RECENCY_HORIZON_DAYS);
}

// ─────────────────────────────────────────────────────────────────────────────
// WHICH TABLES, AND WHY EACH BOUND IS ITS OWN (issue #5037).
//
// The diff above read `activities` and nothing else, so the header's promise —
// "or a saved row" — was true of one table out of the eighty-four that carry a
// `profile_id`. `e2e/manual-vitals.spec.ts` logged today's sleep on profile 1
// through the real measurements form; `e2e/sleep-page.spec.ts` asserts the seeded
// night as its last-night hero; #5017's duration manifest put the two files in one
// shard and the hero read the neighbour's night. Nothing in this file could see it.
//
// THE POPULATION WAS MEASURED BEFORE THE WIDENING, not guessed. Every test in the
// suite (479 spec files) ran with a probe that diffed all 84 profile-owned tables
// for profile 1 across each test, and the count is what makes each line below
// affordable or not:
//
//   metric_samples     4 files leave a TODAY-dated row  → watched
//   mood_logs          0 files                          → watched, free
//   medical_records    7 files                          → watched from #5266
//   appointments       6 · food_daily_totals 4 · body_metrics 3 · food_log_events 3
//   profile_settings  36 files, and it has NO date column at all
//
// SO THE BOUND IS PER TABLE, because the surface that consumes each one is:
//
//  • `activities` keeps its 84 days: Analyze's default range is what #3930 broke.
//  • `metric_samples` and `mood_logs` are watched for TODAY AND LATER ONLY. Their
//    contended surfaces are DAY-keyed, not range-ranked — the last-night hero reads
//    exactly one wake-day, the mood log reads one date — and today is also where a
//    form's default date lands, so it is where an accidental write goes. Copying
//    activities' 84 days would red every spec that seeds a month of history, which
//    is most of the sleep and trends fixtures, to buy a defect nobody has.
//  • NOT `profile_settings`, and #5266 censused it by KEY to find out whether a
//    narrower watch was affordable where a whole-table one is not. It is not, and
//    the count is the finding. 36 files move it across 33 keys; dropping the four
//    the APP writes on its own — `routine_position_advanced_1` (23 movements in 17
//    files) and three `notify_last_esc_*` — still leaves 17 files, each of which
//    would then need a cleanup or a declaration. And what those 17 are moving is
//    mostly not a CHANGE: 139 of the 147 movements MATERIALISE a key that had no
//    row, because the settings forms post their whole field set on every save;
//    only 4 overwrite an existing value, and all four are in one file
//    (`digest-time-suggestion`). Telling a materialised DEFAULT apart from a
//    materialised CHANGE needs every key's default held a second time inside the
//    guard — a copy of `lib/settings`' own knowledge, kept somewhere that cannot
//    see it go stale — which is worth more than the defect. The unit preferences
//    are not in this table at all: they live in `login_settings`, keyed by LOGIN,
//    so no profile-scoped watch could ever see them. The per-key table is in
//    docs/internals/e2e-hygiene.md.
//  • `medical_records` joined at #5266, on the same TODAY-ONWARD bound and for the
//    same reason: its contended surfaces read the LATEST reading under a canonical
//    name, so today's row is the one a later test sees. Re-derived at that issue
//    from #5037's own per-test rows — 11 files move the table and 7 of them do so
//    on or after the frozen day:
//
//      fitness-percentile · illness-episode-followups · illness-round3 ·
//      manual-vitals · measurements-form-layout · unit-mislabel-review ·
//      view-only-access
//
//    The other 4 are inert exactly as `palette-deeplinks`' 2019 insert is, because
//    every one is dated well before the run: clinical-duplicate-import (2019 CCDA
//    lipids), lab-result-lifecycle (2026-01), clinical-undo (2026-04) and
//    ia-nutrition-medications (an August folate it REMOVES).
//    Unlike the two above it is INSERT-only on every manual path, so a leak here
//    is usually a surplus row the repair below can take back out. The exception is
//    `measurements-form-layout`, which CLEARS today's manual vitals as a
//    precondition it owns — a REMOVED row, which no repair can invent — so it
//    copies the day first and puts it back.
//
// INSERTS, UPDATES AND DELETES ARE ALL IN, and they always were — the diff is a
// MULTISET COMPARISON of the signature columns, so an in-place edit reads as one
// REMOVED plus one ADDED, and a delete reads as REMOVED with nothing opposite it.
// That matters more here than it did for activities: a `metric_samples` save
// REPLACES the day's rows for that metric rather than adding to them, and
// `mood_logs` is UNIQUE on (profile_id, date), so the ordinary way to leak these
// two tables is to DESTROY the seed's row, which a count or an insert-only watch
// could not see. Only ADDED rows can be repaired; a removal is reported and left,
// for the reason `repairAddedSharedRows` gives.

export interface WatchedSharedTable {
  readonly table: string;
  /** The columns a later test can SEE. `date` FIRST — it is the horizon column. */
  readonly columns: readonly string[];
  /** The column a spec names its declared leftovers by. */
  readonly handle: string;
  /** Oldest watched day, in days back from the frozen instant. 0 = today onward. */
  readonly horizonDays: number;
  /** What a row left here does to a LATER test — the failure message's why. */
  readonly consequence: string;
  /** What the leaking spec should do instead. */
  readonly cleanup: string;
}

export const WATCHED_SHARED_TABLES = [
  {
    table: "activities",
    columns: ["date", "type", "title"],
    handle: "title",
    horizonDays: SHARED_RECENCY_HORIZON_DAYS,
    consequence:
      "Analyze's quick links give each kind ONE slot, filled by that kind's most " +
      "recent item, so a row left here silently re-ranks the strip for every later " +
      "test on this worker and fails one of them instead of this one (#3930).",
    cleanup:
      "deleteActivitiesTitled(...) from e2e/shared-profile-guard.ts, called from an " +
      "`afterEach` or a `finally` so an earlier failure cannot skip it",
  },
  {
    table: "metric_samples",
    columns: ["date", "metric", "source", "started_at", "ended_at", "value"],
    handle: "metric",
    horizonDays: 0,
    consequence:
      "The last-night hero reads exactly one wake-day and takes the LONGEST session " +
      "in it, so a night written here renders as somebody else's last night — that " +
      "is #5037, and the spec that noticed had stated in its own header that it " +
      "drove no writes on the shared profile. A save REPLACES the day's rows for " +
      "that metric, so a leak here can delete the seed's night as well as add one.",
    cleanup:
      'sharedDayRestorePoint("metric_samples", date) from ' +
      "e2e/shared-profile-guard.ts — armed before the write, called from an " +
      "`afterEach` or a `finally` so an earlier failure cannot skip it",
  },
  {
    table: "medical_records",
    columns: ["date", "category", "name", "value", "unit"],
    handle: "name",
    horizonDays: 0,
    consequence:
      "Every reading surface here ranks by recency under a canonical name — the " +
      "dashboard's vitals tiles, the body census, the metric detail page's " +
      "readings table — so today's row is the one a later test reads. " +
      "`manual-vitals` asserts a row COUNT of 1 on four metric pages because the " +
      "seed carries none; a neighbour's respiratory rate is enough to fail it.",
    cleanup:
      "delete the row this test wrote (its `name` and `date` address it), from an " +
      "`afterEach` or a `finally` so an earlier failure cannot skip it — or, if the " +
      'write REPLACED a seeded row, sharedDayRestorePoint("medical_records", date) ' +
      "from e2e/shared-profile-guard.ts, armed before the write",
  },
  {
    table: "mood_logs",
    columns: ["date", "valence", "energy", "anxiety", "factors", "notes"],
    handle: "date",
    horizonDays: 0,
    consequence:
      "The sleep-and-mood log reads one row per date and the table is UNIQUE on " +
      "(profile_id, date), so a check-in written here does not join the day — it " +
      "REPLACES whatever the seed put there, for every later test on this worker.",
    cleanup:
      'sharedDayRestorePoint("mood_logs", date) from e2e/shared-profile-guard.ts — ' +
      "armed before the write, called from an `afterEach` or a `finally`",
  },
] as const satisfies readonly WatchedSharedTable[];

export type WatchedSharedTableName =
  (typeof WATCHED_SHARED_TABLES)[number]["table"];

/** What a spec may leave behind, said in the spec's own source. */
export interface SharedProfileLeftovers {
  /** Why these rows must outlive the test. Required; NOT checked for truth (#3260). */
  why: string;
  /**
   * The rows this spec means to leave, each named by its table's own HANDLE — an
   * `activities.title`, a `metric_samples.metric`, a `mood_logs.date`. One flat
   * list rather than one per table: the handle is what the matching cleanup
   * addresses rows by, so a spec cannot declare a row it has no way to name.
   */
  rows: readonly string[];
}

export const NO_LEFTOVERS: SharedProfileLeftovers = { why: "", rows: [] };

/**
 * The rows a later test can see, as `{ table, id, handle, signature }`.
 *
 * Ids ride along only so the repair below can address the rows it removes; the DIFF
 * never looks at them.
 */
export type SharedRowSnapshot = {
  table: WatchedSharedTableName;
  id: number;
  handle: string;
  signature: string;
}[];

export interface SharedRowDrift {
  /** Rows this test added, newest id first within each table. */
  added: { table: string; id: number; handle: string; signature: string }[];
  /** Signatures this test removed, and how many of each. */
  missing: {
    table: string;
    handle: string;
    signature: string;
    count: number;
  }[];
  /** Declared handles this test did not actually leave — the declaration is stale. */
  staleDeclarations: string[];
}

/**
 * Read profile 1's in-horizon rows for every watched table, in ONE connection.
 *
 * The signature columns are what the contended surfaces actually consume, so a row
 * re-dated, re-timed or renamed in place registers as a disturbance even though its
 * id never moved. A count would have missed all three.
 */
export function snapshotSharedRows(
  now: Date,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): SharedRowSnapshot {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 5000");
    const out: SharedRowSnapshot = [];
    for (const watched of WATCHED_SHARED_TABLES) {
      const rows = db
        .prepare(
          `SELECT id, ${watched.columns.map((c) => `"${c}"`).join(", ")}
             FROM "${watched.table}"
            WHERE profile_id = ? AND date >= ?
            ORDER BY id`
        )
        .all(profileId, horizonStart(now, watched.horizonDays)) as Record<
        string,
        unknown
      >[];
      for (const row of rows)
        out.push({
          table: watched.table,
          id: Number(row.id),
          handle: String(row[watched.handle] ?? ""),
          signature: watched.columns.map((c) => String(row[c] ?? "")).join("|"),
        });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Compare two snapshots, per table, and drop everything this spec DECLARED.
 *
 * The declaration is matched on the table's HANDLE, which is the same value its
 * cleanup addresses rows by — so the two halves of the convention stay spelled the
 * same way and a spec cannot declare a row it cannot name.
 */
export function diffSharedRows(
  before: SharedRowSnapshot,
  after: SharedRowSnapshot,
  declared: SharedProfileLeftovers = NO_LEFTOVERS
): SharedRowDrift {
  const tally = (snapshot: SharedRowSnapshot) => {
    const counts = new Map<string, Map<string, number>>();
    for (const row of snapshot) {
      let table = counts.get(row.table);
      if (!table) counts.set(row.table, (table = new Map()));
      table.set(row.signature, (table.get(row.signature) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = tally(before);
  const afterCounts = tally(after);

  // The FULL movement first, then the declaration is applied as a partition — which
  // is what makes a declaration that covers nothing visible instead of free.
  const added: SharedRowDrift["added"] = [];
  const missing: SharedRowDrift["missing"] = [];
  for (const watched of WATCHED_SHARED_TABLES) {
    const beforeTable = beforeCounts.get(watched.table) ?? new Map();
    const afterTable = afterCounts.get(watched.table) ?? new Map();
    // Surplus copies are attributed NEWEST FIRST, so the row the repair removes is
    // the one this test just wrote rather than a seeded twin of it.
    const newestFirst = after
      .filter((row) => row.table === watched.table)
      .sort((a, b) => b.id - a.id);
    for (const [signature, count] of afterTable) {
      let surplus = count - (beforeTable.get(signature) ?? 0);
      if (surplus <= 0) continue;
      for (const row of newestFirst) {
        if (surplus === 0) break;
        if (row.signature !== signature) continue;
        added.push({
          table: watched.table,
          id: row.id,
          handle: row.handle,
          signature,
        });
        surplus -= 1;
      }
    }
    const handleIndex = (watched.columns as readonly string[]).indexOf(
      watched.handle
    );
    for (const [signature, count] of beforeTable) {
      const deficit = count - (afterTable.get(signature) ?? 0);
      if (deficit > 0)
        missing.push({
          table: watched.table,
          handle: signature.split("|")[handleIndex] ?? "",
          signature,
          count: deficit,
        });
    }
  }

  const declaredHandles = new Set(declared.rows);
  const covered = new Set<string>();
  const cover = (handle: string) => {
    if (!declaredHandles.has(handle)) return false;
    covered.add(handle);
    return true;
  };
  return {
    added: added.filter((row) => !cover(row.handle)),
    missing: missing.filter((row) => !cover(row.handle)),
    staleDeclarations: declared.rows.filter((row) => !covered.has(row)),
  };
}

/**
 * ONE CALLER, ONE NARROWER QUESTION (#5037).
 *
 * `entry-ergonomics` asks whether a save that was FORCED to fail nevertheless left
 * an ACTIVITY row (#332/#4741) — a claim that must hold whatever the other watched
 * tables did. Handing the general diff an activities-only pair of snapshots answers
 * exactly that, so there is no second diff here, only a narrower question. Delete
 * both if that spec ever stops asking it.
 */
export function snapshotRecentActivities(
  now: Date,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): SharedRowSnapshot {
  return snapshotSharedRows(now, dbPath, profileId).filter(
    (row) => row.table === "activities"
  );
}

export function diffRecentActivities(
  before: SharedRowSnapshot,
  after: SharedRowSnapshot,
  declared: SharedProfileLeftovers = NO_LEFTOVERS
): SharedRowDrift {
  return diffSharedRows(before, after, declared);
}

/**
 * Delete every activity on the shared profile with one of these titles.
 *
 * The one copy of the cleanup the convention asks for (#3946). It lived verbatim in
 * `form-drafts.spec.ts` and `stale-build-save.spec.ts` and inline in
 * `autosave-retry.spec.ts` before this. Child rows (components, routes, videos)
 * cascade off the activity, which is why `foreign_keys` is on.
 */
export function deleteActivitiesTitled(...titles: string[]): void {
  if (titles.length === 0) return;
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const drop = db.prepare(
      "DELETE FROM activities WHERE profile_id = ? AND title = ?"
    );
    for (const title of titles) drop.run(SHARED_PROFILE_ID, title);
  } finally {
    db.close();
  }
}

/**
 * Copy the shared profile's `table` rows for ONE day, and return the restore.
 *
 * THE CLEANUP A DAY-KEYED WRITE NEEDS, and the reason it is not a delete (#5037).
 * A `metric_samples` save replaces the day's rows for its metric and a `mood_logs`
 * save replaces the day's check-in, so a spec that drives one of those forms has
 * DESTROYED seeded rows by the time it could delete what it added. Deleting the
 * day instead — "clear today's sleep in cleanup" — is worse still: it takes the
 * seed's night and its naps from every later test on the worker, which is the leak
 * this guard exists to catch, wearing the costume of a fix.
 *
 * So the day is copied before the write and put back after it, exactly as it was.
 * The restore is safe because a worker runs ONE test at a time: nothing else can
 * have written to this profile in between, so there is no row to race. It is not
 * safe against a Server Action still committing when the test ended — see the
 * attribution note on `sharedRowDriftMessage`.
 *
 * Restored rows come back with NEW ids, which the diff is deliberately blind to:
 * it compares signature MULTISETS, exactly as it does for training-log-merge's undo.
 *
 * THE NEW IDS ARE NOT FREE ON `medical_records` (#5266), which is the first watched
 * table that is an FK PARENT. Three children cascade off a record id —
 * `instrument_responses` (066), `medical_record_revisions` (120) and
 * `preventive_record_decisions` (20260819) — so restoring a day whose rows have
 * children would take the children with them, and the plain
 * `REFERENCES medical_records(id)` columns
 * (`care_plan_items` follow-ups, `intake_items.source_record_id`) would make the
 * restore's DELETE fail outright instead, since this function runs with
 * `foreign_keys = ON`. Either way it is loud, not silent.
 *
 * Profile 1's seed carries exactly ONE record dated on or after the run's frozen
 * day — a manual Body Temperature of 99.2 degF — and it has no rows in any of
 * those three cascading children, so every caller here is safe. Read it back with
 * `SELECT id, date, name, value FROM medical_records WHERE profile_id = 1 AND
 * date >= <frozen day>` against a worker's copy of the template.
 *
 * A spec restoring a day that holds an instrument score is the case this does not
 * cover; it should delete its own row instead.
 */
export function sharedDayRestorePoint(
  table: WatchedSharedTableName,
  date: string,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): () => void {
  const columns = ["profile_id", ...allColumns(table, dbPath)];
  const db = new Database(dbPath);
  let held: unknown[][] = [];
  try {
    db.pragma("busy_timeout = 5000");
    held = (
      db
        .prepare(
          `SELECT ${columns.map((c) => `"${c}"`).join(", ")}
             FROM "${table}" WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, date) as Record<string, unknown>[]
    ).map((row) => columns.map((c) => row[c] ?? null));
  } finally {
    db.close();
  }
  return () => {
    const handle = new Database(dbPath);
    try {
      handle.pragma("busy_timeout = 5000");
      handle.pragma("foreign_keys = ON");
      const insert = handle.prepare(
        `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`
      );
      handle
        .transaction(() => {
          handle
            .prepare(`DELETE FROM "${table}" WHERE profile_id = ? AND date = ?`)
            .run(profileId, date);
          for (const row of held) insert.run(row);
        })
        .immediate();
    } finally {
      handle.close();
    }
  };
}

/**
 * Every column the restore has to carry — the signature columns are what the DIFF
 * reads, but a row put back without its untouched neighbours (`value`'s units, a
 * mood's factors, an import's `origin`) is a different row to the app.
 */
function allColumns(table: WatchedSharedTableName, dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[]
    )
      .map((column) => column.name)
      .filter((name) => name !== "id" && name !== "profile_id");
  } finally {
    db.close();
  }
}

/**
 * Remove the rows this test ADDED, so exactly one test fails instead of every test
 * after it — the same repairing-detector argument `takeStrandedDrafts` makes.
 *
 * A REMOVAL cannot be repaired: the guard knows the row went but not what the seed
 * meant it to be, and inventing a restore would be a second producer of the seed's
 * truth. The message says so rather than pretending otherwise — and
 * `sharedDayRestorePoint` is how a spec that KNOWS puts the day back itself.
 */
export function repairAddedSharedRows(
  drift: SharedRowDrift,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): void {
  if (drift.added.length === 0 || !fs.existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    for (const row of drift.added)
      db.prepare(
        `DELETE FROM "${row.table}" WHERE id = ? AND profile_id = ?`
      ).run(row.id, profileId);
  } finally {
    db.close();
  }
}

/**
 * The rows that moved, one section per watched table: what moved, the bound that
 * admitted it, what it does to a later test, and the cleanup that prevents it.
 *
 * Shared by both readers of a drift — the test's own window and the gap before it
 * (#5266) — because the rows and their consequences are the same facts either way.
 * Only the sentence naming WHO moved them differs, and that is the caller's.
 */
function driftSections(drift: SharedRowDrift, now: Date): string {
  const sections: string[] = [];
  for (const watched of WATCHED_SHARED_TABLES) {
    const added = drift.added.filter((row) => row.table === watched.table);
    const missing = drift.missing.filter((row) => row.table === watched.table);
    if (added.length + missing.length === 0) continue;
    const lines = [
      ...added.map(
        (row) => `  • ADDED ${row.table} ${row.id} — ${row.signature}`
      ),
      ...missing.map(
        (row) =>
          `  • REMOVED ${row.count === 1 ? "" : `${row.count}× `}${row.table} — ` +
          `${row.signature} (deleted, or re-dated / edited away)`
      ),
    ];
    sections.push(
      `${lines.join("\n")}\n` +
        `  Watched: rows dated on or after ` +
        `${horizonStart(now, watched.horizonDays)}` +
        `${watched.horizonDays === 0 ? " (today onward)" : ` (${watched.horizonDays} days back)`}` +
        `, measured from the run's frozen instant.\n` +
        `  ${watched.consequence}\n` +
        `  Fix: ${watched.cleanup}.`
    );
  }
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GAP BETWEEN TWO TESTS, AND WHO OWNS IT (#5266).
//
// The per-test diff cannot see a write that escapes its own window, and the header
// of this file measures that window: 61, 106 and 76 ms past `context.close()`. An
// escaped write lands in the NEXT test's `before` reading and is invisible from
// then on. Comparing each test's `before` against the previous test's `after` is
// exactly that window, and it costs no extra query — both readings are already
// taken.
//
// ATTRIBUTION IS THE WHOLE PROBLEM, NOT DETECTION. A guard that reports a real leak
// against the wrong test is worse than one that misses it: the next person spends an
// afternoon reading an innocent spec. And one other thing runs in that window — a
// new file's `beforeAll`, which Playwright runs before any of that file's test
// fixtures (that is also why the `before` reading is taken in the fixture and not in
// a `beforeEach`). So a gap that spans a FILE BOUNDARY holds the new file's
// `beforeAll` as well as the old file's escape, and the two are indistinguishable by
// content.
//
// The rule (ruled 2026-09-05 on #5266): a gap spanning a file boundary is charged to
// the NEW file's `beforeAll` and NEVER to the previous file's last test. A false
// accusation across files is worse than a missed leak, and this avoids both — the
// window really does belong to that `beforeAll`, and the innocent spec in the other
// file is never named.

/** Where a test sat in the run, as the guard names it in a report. */
export interface TestPosition {
  /** The spec file's name, e.g. `manual-vitals.spec.ts`. */
  file: string;
  /** The test's own title. */
  title: string;
}

/**
 * Who owned the window between two tests. A closed union rather than a boolean, so
 * the message cannot render a boundary as if a test had been named.
 */
export type SharedRowGapCulprit =
  | { kind: "previous-test"; name: string }
  | { kind: "before-all"; name: string };

/** Charge the window between `previous` and the test now starting in `currentFile`. */
export function attributeSharedRowGap(
  previous: TestPosition,
  currentFile: string
): SharedRowGapCulprit {
  return previous.file === currentFile
    ? { kind: "previous-test", name: `${previous.file} › ${previous.title}` }
    : { kind: "before-all", name: `${currentFile} beforeAll` };
}

/** The failure a gap earns, naming the window's owner and never anybody else. */
export function sharedRowGapMessage(
  culprit: SharedRowGapCulprit,
  drift: SharedRowDrift,
  now: Date
): string {
  const moved = drift.added.length + drift.missing.length;
  return (
    `${moved} row(s) moved on the SHARED profile ${SHARED_PROFILE_ID} BETWEEN two ` +
    `tests, in the window ${culprit.name} owns (#5266):\n\n` +
    `${driftSections(drift, now)}\n\n` +
    (culprit.kind === "previous-test"
      ? `Nothing else ran in that window. A Server Action does not stop when its ` +
        `browser context does — #4788 measured a row landing 61, 106 and 76 ms ` +
        `after \`context.close()\` returned — so a save nothing awaited escapes ` +
        `its own test's teardown and arrives here. End that test on its own save: ` +
        `await the response, or the assertion that reads it back.\n\n`
      : `That window spans a FILE BOUNDARY, so it is charged to the new file's ` +
        `\`beforeAll\` and never to the previous file's last test — a spec in ` +
        `another file cannot be blamed for a window it did not own. Playwright ` +
        `runs TWO hooks in there: this file's \`beforeAll\`, and the previous ` +
        `file's \`afterAll\` (which is why a REMOVED row can appear here). Read ` +
        `both. A hook that touches the shared profile should date its rows ` +
        `outside the watched bound, the way the other file-owned fixtures do, or ` +
        `use a profile of its own (#868). Nothing has been repaired: a row a file ` +
        `owns for its whole run is not this guard's to take.\n\n`) +
    `This is reported on the test that FOUND it — the window closed before that ` +
    `test began — so read the name above, not the test that failed.` +
    (culprit.kind === "previous-test" && drift.added.length > 0
      ? `\n\nThe ADDED rows above have been removed so the rest of this worker's ` +
        `run is unaffected. `
      : ``) +
    (culprit.kind === "previous-test" && drift.missing.length > 0
      ? `\n\nThe REMOVED rows have NOT been put back — this guard knows they went, ` +
        `not what the seed meant them to be.`
      : ``)
  );
}

/** The failure message a stranded saved row earns, naming the rows it moved. */
export function sharedRowDriftMessage(
  drift: SharedRowDrift,
  now: Date
): string {
  if (drift.staleDeclarations.length > 0)
    return (
      `This test declares sharedProfileLeftovers it did not leave (#3946):\n` +
      drift.staleDeclarations.map((row) => `  • "${row}"`).join("\n") +
      `\n\nA declaration that covers nothing is an exemption nobody can see the ` +
      `edge of — the cleanup was added, or the fixture moved, and the handle stayed. ` +
      `Drop it from the \`rows\` list.\n\n` +
      `IF THIS FILE HAS SEVERAL TESTS and only some leave the row, \`test.use\` at ` +
      `file scope is too wide: move it into a \`test.describe\` around the tests ` +
      `that do.\n\n` +
      `This says nothing about whether a live declaration's \`why\` is still TRUE — ` +
      `nothing checks that (#3260).`
    );

  const moved = drift.added.length + drift.missing.length;
  return (
    `This test moved ${moved} row(s) on the SHARED profile ${SHARED_PROFILE_ID} ` +
    `and left them moved (#3946, #5037):\n\n${driftSections(drift, now)}\n\n` +
    `Or, if the rows genuinely must outlive the test, say so in this spec:\n` +
    `    test.use({ sharedProfileLeftovers: { why: "…", rows: ["…"] } });\n\n` +
    (drift.added.length > 0
      ? `The ADDED rows above have been removed so the rest of this worker's run is ` +
        `unaffected. `
      : ``) +
    (drift.missing.length > 0
      ? `The REMOVED rows have NOT been put back — this guard knows they went, not ` +
        `what the seed meant them to be.`
      : ``)
  );
}
