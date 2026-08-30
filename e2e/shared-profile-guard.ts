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
//    leak nobody meant. Instead a spec says, in its own source, which titles it
//    leaves and why — `test.use({ sharedProfileLeftovers: { why, titles } })`.
//
//    THE `why` IS REQUIRED AND ITS TRUTH IS STILL UNCHECKED — #3260's caveat stands
//    and this does not answer it. What IS checked is whether the declaration is still
//    NEEDED: a title declared that the test does not actually leave is reported as
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

/** The oldest day inside the horizon, measured from the run's FROZEN instant. */
export function recencyHorizonStart(now: Date): string {
  return shiftDateStr(
    now.toISOString().slice(0, 10),
    -SHARED_RECENCY_HORIZON_DAYS
  );
}

/** What a spec may leave behind, said in the spec's own source. */
export interface SharedProfileLeftovers {
  /** Why these rows must outlive the test. Required; NOT checked for truth (#3260). */
  why: string;
  /** Exact `activities.title` values this spec means to leave on the shared profile. */
  titles: readonly string[];
}

export const NO_LEFTOVERS: SharedProfileLeftovers = { why: "", titles: [] };

/**
 * The rows a later test can see, as `{ id, "date|type|title" }`.
 *
 * Ids ride along only so the repair below can address the rows it removes; the DIFF
 * never looks at them.
 */
export type SharedActivitySnapshot = { id: number; signature: string }[];

export interface SharedActivityDrift {
  /** Rows this test added, newest id first. */
  added: { id: number; title: string; date: string }[];
  /** `date|type|title` combinations this test removed, and how many of each. */
  missing: { signature: string; count: number }[];
  /** Declared titles this test did not actually leave — the declaration is stale. */
  staleDeclarations: string[];
}

const RECENT_ACTIVITY_SQL = `SELECT id, date, type, title
     FROM activities
    WHERE profile_id = ?
      AND date >= ?
    ORDER BY id`;

/**
 * Read profile 1's in-horizon activities as `id → "date|type|title"`.
 *
 * Those three columns are what a recency-ranked surface actually consumes —
 * `analyzeQuickLinks` sorts on `lastDate` and keys on kind and item — so a row
 * re-dated, re-typed or renamed in place registers as a disturbance even though its
 * id never moved. A count would have missed all three.
 */
export function snapshotRecentActivities(
  now: Date,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): SharedActivitySnapshot {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const rows = db
      .prepare(RECENT_ACTIVITY_SQL)
      .all(profileId, recencyHorizonStart(now)) as {
      id: number;
      date: string;
      type: string;
      title: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      signature: `${r.date}|${r.type}|${r.title}`,
    }));
  } finally {
    db.close();
  }
}

const titleOf = (signature: string) => signature.split("|").slice(2).join("|");

/**
 * Compare two snapshots and drop everything this spec DECLARED it would leave.
 *
 * The declaration is matched on TITLE, which is the same handle
 * `deleteActivitiesTitled` cleans up by — so a spec cannot declare a row it has no
 * way to name, and the two halves of the convention stay spelled the same way.
 */
export function diffRecentActivities(
  before: SharedActivitySnapshot,
  after: SharedActivitySnapshot,
  declared: SharedProfileLeftovers = NO_LEFTOVERS
): SharedActivityDrift {
  const tally = (snapshot: SharedActivitySnapshot) => {
    const counts = new Map<string, number>();
    for (const row of snapshot)
      counts.set(row.signature, (counts.get(row.signature) ?? 0) + 1);
    return counts;
  };
  const beforeCounts = tally(before);
  const afterCounts = tally(after);

  // The FULL movement first, then the declaration is applied as a partition — which
  // is what makes a declaration that covers nothing visible instead of free.
  const added: { id: number; title: string; date: string }[] = [];
  const missing: { signature: string; count: number }[] = [];
  // Surplus copies are attributed NEWEST FIRST, so the row the repair removes is
  // the one this test just wrote rather than a seeded twin of it.
  const newestFirst = [...after].sort((a, b) => b.id - a.id);
  for (const [signature, count] of afterCounts) {
    let surplus = count - (beforeCounts.get(signature) ?? 0);
    if (surplus <= 0) continue;
    const [date] = signature.split("|");
    for (const row of newestFirst) {
      if (surplus === 0) break;
      if (row.signature !== signature) continue;
      added.push({ id: row.id, title: titleOf(signature), date });
      surplus -= 1;
    }
  }
  for (const [signature, count] of beforeCounts) {
    const deficit = count - (afterCounts.get(signature) ?? 0);
    if (deficit > 0) missing.push({ signature, count: deficit });
  }

  const declaredTitles = new Set(declared.titles);
  const covered = new Set<string>();
  const cover = (title: string) => {
    if (!declaredTitles.has(title)) return false;
    covered.add(title);
    return true;
  };
  return {
    added: added.filter((row) => !cover(row.title)),
    missing: missing.filter((row) => !cover(titleOf(row.signature))),
    staleDeclarations: declared.titles.filter((t) => !covered.has(t)),
  };
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
 * Remove the rows this test ADDED, so exactly one test fails instead of every test
 * after it — the same repairing-detector argument `takeStrandedDrafts` makes.
 *
 * A REMOVAL cannot be repaired: the guard knows the row went but not what the seed
 * meant it to be, and inventing a restore would be a second producer of the seed's
 * truth. The message says so rather than pretending otherwise.
 */
export function repairAddedActivities(
  drift: SharedActivityDrift,
  dbPath: string = workerDbPath(),
  profileId: number = SHARED_PROFILE_ID
): void {
  if (drift.added.length === 0 || !fs.existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const drop = db.prepare(
      "DELETE FROM activities WHERE id = ? AND profile_id = ?"
    );
    for (const row of drift.added) drop.run(row.id, profileId);
  } finally {
    db.close();
  }
}

/** The failure message a stranded saved row earns, naming the rows it moved. */
export function sharedActivityDriftMessage(
  drift: SharedActivityDrift,
  now: Date
): string {
  const lines: string[] = [];
  if (drift.staleDeclarations.length > 0)
    return (
      `This test declares sharedProfileLeftovers it did not leave (#3946):\n` +
      drift.staleDeclarations.map((t) => `  • "${t}"`).join("\n") +
      `\n\nA declaration that covers nothing is an exemption nobody can see the ` +
      `edge of — the cleanup was added, or the fixture moved, and the title stayed. ` +
      `Drop it from the \`titles\` list.\n\n` +
      `IF THIS FILE HAS SEVERAL TESTS and only some leave the row, \`test.use\` at ` +
      `file scope is too wide: move it into a \`test.describe\` around the tests ` +
      `that do.\n\n` +
      `This says nothing about whether a live declaration's \`why\` is still TRUE — ` +
      `nothing checks that (#3260).`
    );
  for (const row of drift.added)
    lines.push(`  • ADDED activity ${row.id} "${row.title}" (${row.date})`);
  for (const row of drift.missing)
    lines.push(
      `  • REMOVED ${row.count === 1 ? "" : `${row.count}× `}${row.signature} ` +
        `(deleted, or re-dated / renamed away)`
    );
  return (
    `This test moved ${lines.length} activity row(s) on the SHARED profile ` +
    `${SHARED_PROFILE_ID} and left them moved (#3946):\n${lines.join("\n")}\n\n` +
    `Only rows dated on or after ${recencyHorizonStart(now)} are watched — ` +
    `${SHARED_RECENCY_HORIZON_DAYS} days back from the run's frozen instant, which ` +
    `is Analyze's default range. Analyze's quick links give each kind ONE slot, ` +
    `filled by that kind's most recent item, so a row left here silently re-ranks ` +
    `the strip for every later test on this worker and fails one of them instead ` +
    `of this one (#3930).\n\n` +
    `Delete the row in this test — \`deleteActivitiesTitled(...)\` from ` +
    `e2e/shared-profile-guard.ts, called from an \`afterEach\` or a \`finally\` so ` +
    `an earlier failure cannot skip it — or, if it genuinely must outlive the test, ` +
    `say so in this spec:\n` +
    `    test.use({ sharedProfileLeftovers: { why: "…", titles: ["…"] } });\n\n` +
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
