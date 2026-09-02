import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEDGERS_WITH_LOGGED_VIA } from "@/lib/logged-via";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";

// THE USER-WRITE LEDGER CENSUS (#3087).
//
// `logged_via` is only worth having if the set of ledgers carrying it is a DECIDED set
// rather than an accident. So every table this app INSERTs into from its own source
// must declare itself: either it is in the tranche that carries provenance, or it is
// out with a stated reason. A new table cannot join the app silently.
//
// TWO QUESTIONS, TWO ASSERTIONS:
//   1. every inserted table is declared (in the tranche, or excluded with a sentence);
//   2. every INSERT into a TRANCHE table names `logged_via`.
//
// (2) is the half a type cannot cover. Threading a required argument through the write
// cores makes a MISSING CALLER a compile error — but a hand-written
// `INSERT INTO body_metrics (…)` that simply omits the column compiles perfectly and
// stores NULL for ever. That is not hypothetical: writing this guard is how
// `insertBodyMetric` was found doing exactly that, after the whole call-site pass had
// already gone green.
//
// WHY THIS SCANS TEXT AND NOT THE DATABASE. The question is about the app's WRITE
// PATHS, not about the schema — a column can exist while nothing populates it. A text
// scan is also pure, so it lives in the fast tier beside the repo's other source
// guards. `lib/__db_tests__/logged-via-provenance.test.ts` asks the schema half.
//
// THE INSERT SPELLINGS ARE THE REPO'S OWN, not the issue's. Over the whole tracked
// set — `git grep -o -i '<spelling>' | wc -l`, on 2026-08-22 — the repo writes
// `INSERT INTO` 4053 times, `INSERT OR IGNORE INTO` 117 and `INSERT OR REPLACE INTO`
// 19, so the pattern accepts the whole `INSERT OR <verb> INTO` family rather than the
// bare form the issue happened to write. Those three figures are a SNAPSHOT of the
// tracked tree (most of it migrations and fixtures this corpus excludes) and drift
// with every merge; nothing asserts them. What the pattern must cover is the SET of
// spellings, and that is what the reach test below plants and proves.
//
// WHERE THIS SCAN REACHES, AND WHERE IT DOES NOT (#3566 item 1). The corpus is `lib/`,
// every Server Action and route handler under `app/`, and ALL of `scripts/`. `scripts/`
// was added because it is a real write surface and it was invisible: `scripts/seed.ts`
// and `scripts/seed-personas.ts` between them hand-write ~35 INSERTs into tranche
// ledgers, so a guard whose whole job is "a ledger cannot be written without naming its
// origin" was silent about the largest body of hand-written tranche INSERTs in the tree.
// A root that is never entered is not covered by the `git ls-files` cross-check below
// either — that check finds an UNTRACKED file under a SCANNED root, a different hole.
//
// `e2e/` IS EXCLUDED, ON PURPOSE AND WITH A REASON, because silence would read as
// coverage. Its seed helpers and its spec files are TEST FIXTURES: they build a database
// to drive an assertion, exactly like `lib/__db_tests__/fixtures.ts`, which this corpus
// already excludes by directory. A fixture's rows stand in for whatever the spec needs
// them to be, so requiring `logged_via` there would make every spec author invent
// provenance for a person who does not exist — and unlike the seeds, an e2e fixture
// ships no demo instance anybody reads. If a future feature reads `logged_via` in an e2e
// assertion, that fixture will name the column because its spec needs it to.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Extensions this census reads.
 *
 * `.mjs` is included because `scripts/` holds two dozen of them and nothing stops one
 * from hand-writing an INSERT. None does today; the point is that a file-extension rule
 * must not be the reason a write path is invisible. `lib/` and `app/` hold no `.mjs` at
 * all, so this widens nothing there.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs"];

/** Every `INSERT [OR verb] INTO <table>` this repo writes, however it is spelled. */
const INSERT_RE =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+([a-z_][a-z0-9_]*)/gi;

/**
 * Reasons a table is NOT a user-write ledger. Each entry is a sentence a reviewer can
 * disagree with — that is the point. Adding a table to the app means adding a line
 * here, which costs thirty seconds and buys the guarantee that nobody ever ships a
 * ledger of hand-logged health facts with no record of where they came from.
 */
const NOT_A_USER_WRITE_LEDGER: Record<string, string> = {
  // ── children of a tranche parent: the parent row carries the tap's provenance ──
  activity_laps: "child of activities; the session row carries the tap",
  activity_routes: "child of activities; the session row carries the tap",
  activity_segment_efforts:
    "child of activities; the session row carries the tap",
  activity_telemetry: "child of activities; the session row carries the tap",
  activity_videos:
    "attachment on an activities row, not an occurrence of its own",
  exercise_sets: "child of activities; the session row carries the tap",
  allergy_reactions: "child of allergies",
  instrument_responses: "per-item answers under one medical_records score row",
  lesion_photos: "attachment on a skin_lesions row",
  medical_record_revisions: "revision history OF a medical_records row",
  symptom_photos: "attachment on a symptom day, not a log of its own",
  symptom_videos: "attachment on a symptom day, not a log of its own",
  fitness_assessment_entries:
    "per-test entries of one battery; the battery's activities row carries the tap",
  fitness_assessments:
    "the battery container; the activities row it creates carries the tap",

  // ── derived or recomputed from a ledger that already carries provenance ──
  food_daily_totals:
    "day counter recomputed beside the stamped food_log_events rows",
  coverage_gaps: "derived from the record set, never entered",
  document_coverage_markers: "derived from a document's extraction",
  insights: "derived output",
  intake_item_suggestions: "derived suggestion, not a logged occurrence",
  narratives: "generated text, not a person's entry",

  // ── definitions and schedules: the thing being tracked, not an occurrence of it ──
  canonical_result_definitions: "curated vocabulary",
  endurance_plans: "a plan, not a session",
  equipment: "a definition",
  frequency_targets: "a target, not a session logged against it",
  goals: "a target",
  intake_dose_schedule_versions: "schedule history",
  intake_item_doses: "the schedule, not a dose taken",
  intake_item_ingredients: "composition of an item",
  intake_item_pairs: "a declared relationship between items",
  intake_item_purposes: "why an item is taken, not a dose taken",
  intake_items: "the item being tracked",
  medication_courses: "the prescribed course, not an administration",
  preventive_overrides: "a standing decision about screening",
  preventive_record_decisions: "a standing decision about a record",
  protocols: "a definition",
  routine_days: "part of a routine definition",
  routine_slots: "part of a routine definition",
  routines: "a definition",
  shared_supplies: "household supply bookkeeping",
  saved_items: "a star — a preference about a view",
  upcoming_dismissals: "a dismissal of a card, not a health fact",
  providers: "directory entry",
  provider_affiliations: "directory entry",
  portals: "directory entry",
  episode_encounters: "link table",
  episode_stopped_meds: "link table",

  // ── ingest and import machinery: `source` is the authoritative axis there ──
  genomic_variants: "imported panel results; `source` names the producer",
  glucose_trace: "a sensor stream, not a tap",
  hr_minutes: "a device stream, not a tap",
  import_jobs: "import machinery",
  import_pair_decisions: "import machinery",
  import_tombstones: "import machinery",
  med_link_decisions: "import machinery",
  visit_link_decisions: "import machinery",
  medical_documents:
    "the uploaded document itself; the rows extracted from it are the ledger",
  integration_backfill_jobs: "integration machinery",
  integration_connections: "integration machinery",
  integration_sync_events: "integration machinery",
  integration_sync_rows: "integration machinery",
  stream_frontiers: "sync bookkeeping",
  weather_days: "third-party observation about the world, not about a person",
  weather_uv_hours:
    "third-party observation about the world, not about a person",

  // ── notification sidecar: what the app SENT, never what a person logged ──
  notify_lifecycle: "send bookkeeping",
  notify_messages:
    "the live-keyboard reconcile ledger (#1779), pruned at 3 days",
  notify_offers: "stored offer payloads beside notify_messages (#2460)",
  notify_post_workout_claims: "dispatch claim bookkeeping",
  push_subscriptions: "delivery endpoint registration",

  // ── portal and account infrastructure ──
  pending_portal_identities: "portal auth machinery",
  portal_accounts: "portal auth machinery",
  portal_identities: "portal auth machinery",
  portal_run_reports: "portal run bookkeeping",
  portal_sync_requests: "portal run bookkeeping",

  // ── identity, auth, and app plumbing ──
  ai_usage_counters: "AI spend accounting",
  api_tokens: "an authentication identity",
  audit_events: "the audit log itself",
  deleted_rows: "the undo holding store",
  login_attempts: "auth machinery",
  login_auth_tokens: "auth machinery",
  login_profiles: "auth machinery",
  login_recovery_codes: "auth machinery",
  login_settings: "auth machinery",
  login_totp_challenges: "auth machinery",
  logins: "an authentication identity, not a data subject",
  profiles: "the data subject itself",
  profile_settings: "settings",
  profile_share_links: "sharing machinery",
  replayed_keys: "offline-replay idempotency bookkeeping",
  revoked_sessions:
    "auth machinery — token hashes of deliberately ended sessions (#3053)",
  sessions: "auth machinery",
  settings: "settings",

  // ── user-write ledgers OUTSIDE #3087's first tranche ──
  // Each of these IS a place a person records something about themselves. #3087 named
  // a first tranche and deliberately stopped there, so these say so in their own
  // words rather than hiding among the infrastructure above. Extending provenance to
  // one of them is a migration plus its own call-site pass — never a line moved here.
  allergies: "user-write ledger, outside #3087's first tranche",
  appointments: "user-write ledger, outside #3087's first tranche",
  care_goals: "user-write ledger, outside #3087's first tranche",
  care_plan_items: "user-write ledger, outside #3087's first tranche",
  conditions: "user-write ledger, outside #3087's first tranche",
  cycles: "user-write ledger, outside #3087's first tranche",
  dental_procedures: "user-write ledger, outside #3087's first tranche",
  encounters: "user-write ledger, outside #3087's first tranche",
  family_history: "user-write ledger, outside #3087's first tranche",
  fasts: "user-write ledger, outside #3087's first tranche",
  illness_episodes: "user-write ledger, outside #3087's first tranche",
  imaging_studies: "user-write ledger, outside #3087's first tranche",
  immunization_overrides: "user-write ledger, outside #3087's first tranche",
  immunizations: "user-write ledger, outside #3087's first tranche",
  injuries: "user-write ledger, outside #3087's first tranche",
  intake_item_side_effects: "user-write ledger, outside #3087's first tranche",
  metric_samples: "user-write ledger, outside #3087's first tranche",
  milestones: "user-write ledger, outside #3087's first tranche",
  mood_logs: "user-write ledger, outside #3087's first tranche",
  niggles: "user-write ledger, outside #3087's first tranche",
  optical_prescriptions: "user-write ledger, outside #3087's first tranche",
  preventive_events: "user-write ledger, outside #3087's first tranche",
  procedures: "user-write ledger, outside #3087's first tranche",
  progress_photos: "user-write ledger, outside #3087's first tranche",
  situations: "user-write ledger, outside #3087's first tranche",
  skin_lesions: "user-write ledger, outside #3087's first tranche",
};

function dirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The source surfaces a write path can live in: all of `lib` minus its tests and its
 * MIGRATIONS, every Server Action and route handler under `app`, and all of `scripts`.
 * Same selection the repo's other SQL guards use (lib/__tests__/sql-scan.ts), taught to
 * take a ROOT so the reach tests below can run the whole walker over a corpus written to
 * break it, and widened to `scripts/` per #3566.
 *
 * Migrations are excluded deliberately. A migration's INSERT is a one-shot data move
 * against the schema of its own day; requiring `logged_via` there would either force a
 * fabricated value onto back-filled rows or freeze this guard's vocabulary into files
 * that are immutable by rule.
 *
 * `scripts/` is NOT excused the way migrations are. A seed writes rows a person will
 * read in a demo instance, and #3077's relevance ranker will read the column off them;
 * scripts/seed-logged-via.ts states the two answers the seeds give and why.
 */
const SCANNED_ROOTS = ["lib", "app", "scripts"];

function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of dirents(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(p);
        continue;
      }
      // posix-form relative path, so the checks below match on every platform.
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (!SOURCE_EXTENSIONS.some((ext) => p.endsWith(ext))) continue;
      if (/__(?:db_|action_)?tests__/.test(rel)) continue;
      if (p.endsWith(".test.ts")) continue;
      if (rel.startsWith("lib/migrations/")) continue;
      if (rel.startsWith("lib/") || rel.startsWith("scripts/")) out.push(p);
      else if (p.endsWith("actions.ts") || p.endsWith("route.ts")) out.push(p);
    }
  };
  for (const dir of SCANNED_ROOTS) walk(path.join(root, dir));
  return out.sort();
}

interface Insert {
  file: string;
  table: string;
  statement: string;
}

/**
 * Every INSERT statement in the corpus, with the table it targets and enough of the
 * statement text to see its column list.
 *
 * READS BYTES AS UTF-8 rather than shelling out to a grep, so the files carrying a
 * deliberate NUL separator (pinned in lib/__tests__/nul-byte-census.test.ts) are
 * scanned like any other — `rg` calls those BINARY and skips them, which would make
 * this census report a sweep it never took.
 */
/**
 * How far past `INSERT` a statement is read, in characters.
 *
 * DERIVED FROM THE WIDEST STATEMENT THE TREE ACTUALLY HOLDS, not guessed. Measured
 * 2026-08-26 over the whole corpus, the greatest distance from `INSERT` to the
 * `logged_via` it names is 341 characters — scripts/seed.ts's twenty-four-column Strava
 * import. The window was 400 when `scripts/` joined the corpus, i.e. 59 characters of
 * headroom, and it is the ONLY thing standing between a legitimate seed statement and a
 * false "does not name logged_via". This is the cry-wolf direction, and a census that
 * newly flags correct seed code gets deleted. 800 is that worst case with room for a
 * statement half again as wide.
 *
 * THE NUMBER IS NOT THE GUARD, THOUGH — `columnListVisible` below is. A window can
 * always be outgrown, so the census refuses to render an ABSENCE verdict on a statement
 * whose column list it could not see to the end.
 */
const STATEMENT_WINDOW = 800;

/**
 * Did the window reach the end of the column list?
 *
 * `logged_via` is absent only if the whole column list was read, and every INSERT this
 * repo writes reaches a `VALUES` or a `SELECT` after its columns. Without this, a
 * statement wider than the window would be reported as unstamped when the column is
 * simply out of frame — an absence verdict about text nobody looked at.
 */
function columnListVisible(statement: string): boolean {
  return /\b(?:VALUES|SELECT)\b/i.test(statement);
}

function inserts(root: string): Insert[] {
  const out: Insert[] = [];
  for (const file of sourceFilesUnder(root)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(INSERT_RE)) {
      // From the INSERT forward — enough to see whether `logged_via` is named,
      // without trying to parse SQL out of a template literal.
      const statement = src.slice(m.index, m.index + STATEMENT_WINDOW);
      out.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        table: m[1],
        statement,
      });
    }
  }
  return out;
}

const TRANCHE = new Set<string>(LEDGERS_WITH_LOGGED_VIA);

function truncatedTrancheInserts(found: Insert[]): string[] {
  return found
    .filter((i) => TRANCHE.has(i.table) && !columnListVisible(i.statement))
    .map((i) => `${i.file}: INSERT INTO ${i.table}`);
}

/**
 * The corpus floor. Measured 2026-08-26 over `lib` + `app` actions/routes + `scripts`:
 * 1463 files scanned, 373 INSERT statements, 123 distinct tables. Set well below the
 * real figures so ordinary churn does not trip them and a COLLAPSED SCAN does. (The
 * repo-wide `INSERT INTO` count is far larger; most of it is migrations and e2e
 * fixtures, which this corpus excludes by design and says so above.)
 */
const FLOOR_TABLES = 105;
const FLOOR_STATEMENTS = 250;
/** The named subject: the ledger #3087 was opened about. */
const FLOOR_SUBJECT = "intake_item_logs";

/**
 * The census, derived ONCE and GATED BY ITS OWN FLOOR (#3566 item 2).
 *
 * AN ABSENCE ASSERTION FAILS OPEN, and every verdict below is one — "nothing
 * undeclared", "nothing unstamped", "nothing stale". A walker that found no files at
 * all satisfies all three perfectly. The floor used to live in a SIBLING `it`, so a
 * collapsed scan reported one red beside three greens, and a reader triaging that run
 * saw three passing absence checks that had proved nothing.
 *
 * So the floor THROWS here, before any verdict is computed, rather than asserting
 * beside them. Every test that reads the census goes through this function, so there
 * is no route to a green verdict over an empty corpus.
 */
let cachedInserts: Insert[] | undefined;
function census(): Insert[] {
  if (cachedInserts) return cachedInserts;
  const found = inserts(REPO);
  const tables = new Set(found.map((i) => i.table));
  const shortfall: string[] = [];
  if (tables.size < FLOOR_TABLES)
    shortfall.push(`${tables.size} distinct tables (floor ${FLOOR_TABLES})`);
  if (found.length < FLOOR_STATEMENTS)
    shortfall.push(
      `${found.length} INSERT statements (floor ${FLOOR_STATEMENTS})`
    );
  if (!tables.has(FLOOR_SUBJECT))
    shortfall.push(`${FLOOR_SUBJECT} was not found in the corpus at all`);
  if (shortfall.length > 0)
    throw new Error(
      `The logged_via census scanned a corpus too small to make a claim about: ` +
        `${shortfall.join("; ")}. Every verdict in this file is an ABSENCE ` +
        `assertion, so a collapsed walk would report them all green. Fix the walk ` +
        `(SCANNED_ROOTS / SOURCE_EXTENSIONS), or lower the floor deliberately and ` +
        `say why.`
    );
  cachedInserts = found;
  return found;
}

/**
 * EVERY shipped tranche, read out of the migrations' SOURCE TEXT and unioned.
 *
 * Text, not an import, for the reason each migration keeps its own copy at all: a
 * migration describes the schema IT shipped, so it exports `up` and nothing else, and
 * importing a list out of one would invite a later tranche to reuse the same array and
 * quietly change what the earlier one means.
 *
 * THE UNION IS WHAT THE COMMENT BELOW PREDICTED. #4435 shipped tranche 2, so a single
 * migration's literal list can no longer describe the whole tranche; adding the file
 * here — keeping each migration's list literal — keeps this asking "does the constant
 * match what was actually shipped" rather than "does it match the first thing shipped".
 */
const TRANCHE_MIGRATIONS = [
  "lib/migrations/versions/20260822-logged-via-provenance.ts",
  "lib/migrations/versions/20260901-substance-logged-via.ts",
];

function migrationTranche(root: string): string[] {
  return TRANCHE_MIGRATIONS.flatMap((file) =>
    trancheFromSource(fs.readFileSync(path.join(root, file), "utf8"))
  );
}

/**
 * Harvest the tranche out of a migration's source text.
 *
 * COMMENTS ARE STRIPPED FIRST (#3567 item 4). The harvest is "every quoted identifier
 * in the captured block", and a block is text — so commenting a name OUT left it in the
 * harvest, and the migration could ship six columns while this guard read seven. That
 * direction FAILS OPEN: reformatting the array fails closed and is caught, but a
 * demotion written as `// "symptom_logs" — demoted` was invisible here and only the DB
 * tier saw it. This guard exists precisely so the claim survives WITHOUT a database.
 *
 * THROUGH THE SHARED SCANNER, not a local pair of regexes. The obvious two-line
 * spelling strips BLOCK comments first, so a `/*` written inside a `//` sentence opens
 * a comment nothing was meant to close and everything to the next unrelated `*\/`
 * disappears (#3595, and #3087's 1,244 swallowed lines of ActivityForm.tsx). Stripping
 * the WHOLE file before matching the block also means a `const TRANCHE = [` quoted
 * inside a comment cannot be the block this reads.
 */
function trancheFromSource(src: string): string[] {
  const block = /const TRANCHE = \[([\s\S]*?)\] as const;/.exec(
    stripComments(src)
  );
  if (!block) return [];
  return [...block[1].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]);
}

describe("the user-write ledger census", () => {
  it("has a corpus to make a claim about", () => {
    // The floor itself is enforced inside `census()` and THROWS before any verdict is
    // computed (#3566 item 2) — this test states it in the open so a reader can see
    // the numbers, and adds the one check the gate cannot make in general: every
    // tranche member must actually be written from somewhere, or the stamping
    // assertion below is vacuous for it.
    const found = census();
    const tables = new Set(found.map((i) => i.table));
    expect(tables.size).toBeGreaterThanOrEqual(FLOOR_TABLES);
    expect(found.length).toBeGreaterThanOrEqual(FLOOR_STATEMENTS);
    expect([...tables]).toContain(FLOOR_SUBJECT);
    for (const table of TRANCHE) expect([...tables], table).toContain(table);
  });

  it("has every inserted table either in the tranche or excluded with a reason", () => {
    const undeclared = [
      ...new Set(
        census()
          .filter(
            (i) =>
              !TRANCHE.has(i.table) &&
              !Object.hasOwn(NOT_A_USER_WRITE_LEDGER, i.table)
          )
          .map((i) => `${i.table} (first seen in ${i.file})`)
      ),
    ].sort();
    expect(
      undeclared,
      "A table this app writes to has not declared itself (#3087). Either give it " +
        "`logged_via` — a migration plus a required origin argument on its write " +
        "core — and add it to LEDGERS_WITH_LOGGED_VIA, or add one line to " +
        "NOT_A_USER_WRITE_LEDGER saying why it is not a place a person logs " +
        "something about themselves."
    ).toEqual([]);
  });

  it("keeps the exclusion list from outliving the tables it describes", () => {
    // The other direction, so a dropped table leaves the registry rather than sitting
    // there implying a decision about nothing.
    const seen = new Set(census().map((i) => i.table));
    const stale = Object.keys(NOT_A_USER_WRITE_LEDGER)
      .filter((t) => !seen.has(t))
      .sort();
    expect(stale).toEqual([]);
  });

  it("names logged_via in EVERY insert into a tranche ledger", () => {
    const trancheInserts = census().filter((i) => TRANCHE.has(i.table));

    // THE SCOPE CHECK COMES FIRST, because the verdict below is an ABSENCE one and an
    // absence is only meaningful over text that was actually read. A statement wider
    // than STATEMENT_WINDOW would be reported as unstamped while naming the column
    // just past the edge of the frame.
    const truncated = truncatedTrancheInserts(trancheInserts);
    expect(
      truncated,
      `The census read only ${STATEMENT_WINDOW} characters of this statement and ` +
        "never reached its VALUES/SELECT, so it cannot say whether `logged_via` is " +
        "named. Raise STATEMENT_WINDOW and re-measure the comment above it."
    ).toEqual([]);

    const unstamped = trancheInserts
      .filter((i) => !/\blogged_via\b/.test(i.statement))
      .map((i) => `${i.file}: INSERT INTO ${i.table}`);
    expect(
      unstamped,
      "An INSERT into a provenance-carrying ledger does not name `logged_via`, so " +
        "the row it writes reads NULL for ever (#3087). The type system cannot see " +
        "this one — a hand-written column list simply omits the column."
    ).toEqual([]);
  });

  it("agrees with the migration's own tranche, IN BOTH DIRECTIONS", () => {
    // A FORWARD-ONLY CHECK IS SATISFIED BY DELETION, which is the hole this closes.
    // `for (const table of LEDGERS_WITH_LOGGED_VIA)` never visits a name that was
    // removed, so a shipped ledger could be dropped from the tranche and re-declared
    // in NOT_A_USER_WRITE_LEDGER above — "not a place a person logs something about
    // themselves" — while its column, its stamped write cores and every guard here
    // stayed exactly as they are. An adversarial mutant did precisely that to
    // `symptom_logs` and survived both tiers.
    //
    // Sorted-set equality asks both questions at once: a name in the migration and
    // not in the list is a demotion, and a name in the list with no column behind it
    // is a claim about a schema that was never shipped.
    //
    // WHAT TRANCHE 2 DOES TO THIS TEST, said here because it is a red with no obvious
    // right answer otherwise (#3567 item 5). This guard reads ONE migration; the DB
    // guard (lib/__db_tests__/logged-via-provenance.test.ts) reads the LIVE schema. A
    // second tranche migration must grow LEDGERS_WITH_LOGGED_VIA to keep the DB guard
    // green, and that makes THIS one red — correctly, because a single migration's
    // literal list can no longer describe the whole tranche. THIS TEST IS THE SIDE
    // THAT MOVES: replace the single-migration read with the UNION over every shipped
    // logged_via migration, keeping each one's list literal, so the pair keeps asking
    // "does the constant match what was actually shipped" rather than "does it match
    // the first thing that was shipped". Do not relax it to a subset check — a subset
    // check is satisfied by deletion, which is the hole the comment above closes.
    const declared = [...LEDGERS_WITH_LOGGED_VIA].sort();
    const shipped = migrationTranche(REPO).sort();
    expect(shipped.length).toBeGreaterThan(0);
    expect(
      shipped,
      "LEDGERS_WITH_LOGGED_VIA and the migration that added the columns disagree " +
        "(#3087). A ledger cannot be moved out of the tranche by editing a list — " +
        "the column is still there, and demoting it into NOT_A_USER_WRITE_LEDGER " +
        "would make the census claim nobody logs anything on it. IF YOU ARE SHIPPING " +
        "A SECOND TRANCHE, this test is the side that moves: read the union over " +
        "every logged_via migration, not just 20260822's — see the comment above."
    ).toEqual(declared);
  });

  it("declares no table twice", () => {
    const both = [...TRANCHE].filter((t) =>
      Object.hasOwn(NOT_A_USER_WRITE_LEDGER, t)
    );
    expect(both).toEqual([]);
  });
});

describe("the census's reach", () => {
  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE.
  // So the offenders below are PLANTED IN A CORPUS ON DISK and the whole walker is
  // run over it — the file selection, the read, the extraction and the matching.
  // They are deliberately NOT handed to the regex as strings: a reach test that feeds
  // the matcher directly proves the matcher works and leaves the walker — the part
  // that decides which files are looked at at all — completely unexercised. An
  // adversarial lens caught exactly that shape on another guard this session.
  function corpus(files: Record<string, string>): string {
    const root = makeTmpDir("logged-via-census");
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return root;
  }

  it("sees an undeclared table planted in lib/", () => {
    const root = corpus({
      "lib/rogue-write.ts":
        "db.prepare(`INSERT INTO sleep_diaries (profile_id, date) VALUES (?, ?)`).run();\n",
    });
    const found = inserts(root);
    expect(found.map((i) => `${i.file}:${i.table}`)).toEqual([
      "lib/rogue-write.ts:sleep_diaries",
    ]);
    // …and it would be reported, because it is in neither registry.
    expect(
      TRANCHE.has("sleep_diaries") ||
        Object.hasOwn(NOT_A_USER_WRITE_LEDGER, "sleep_diaries")
    ).toBe(false);
  });

  it("sees an unstamped tranche insert planted in a Server Action", () => {
    const root = corpus({
      "app/(app)/x/actions.ts":
        "db.prepare(`INSERT INTO body_metrics (date, weight_kg, profile_id) VALUES (?,?,?)`).run();\n",
    });
    const found = inserts(root).filter((i) => TRANCHE.has(i.table));
    expect(found).toHaveLength(1);
    expect(/\blogged_via\b/.test(found[0].statement)).toBe(false);
  });

  it("sees an unstamped tranche insert planted in scripts/", () => {
    // THE HOLE #3566 WAS FILED ABOUT, planted. Before the corpus reached `scripts/`,
    // this file was simply never opened: ~35 hand-written tranche INSERTs across
    // scripts/seed.ts and scripts/seed-personas.ts sat outside a guard whose whole
    // job is to find hand-written tranche INSERTs.
    const root = corpus({
      "scripts/seed-rogue.ts":
        "db.prepare(`INSERT INTO practice_logs (profile_id, practice, date) VALUES (1,?,?)`).run();\n",
    });
    const found = inserts(root);
    expect(found.map((i) => `${i.file}:${i.table}`)).toEqual([
      "scripts/seed-rogue.ts:practice_logs",
    ]);
    expect(/\blogged_via\b/.test(found[0].statement)).toBe(false);
  });

  it("sees an undeclared table planted in a scripts/*.mjs", () => {
    // The extension half of the same hole. `scripts/` holds two dozen `.mjs` files;
    // none writes SQL today, and the guard must not be blind to the first one that
    // does merely because of how it is spelled.
    const root = corpus({
      "scripts/backfill.mjs":
        "db.exec(`INSERT INTO sleep_diaries (profile_id) VALUES (1)`);\n",
    });
    expect(inserts(root).map((i) => `${i.file}:${i.table}`)).toEqual([
      "scripts/backfill.mjs:sleep_diaries",
    ]);
  });

  it("sees the OR-verb spellings this repo actually uses", () => {
    const root = corpus({
      "lib/spellings.ts":
        "db.exec(`INSERT OR IGNORE INTO practice_logs (profile_id) VALUES (?)`);\n" +
        "db.exec(`INSERT OR REPLACE INTO symptom_logs (profile_id) VALUES (?)`);\n",
    });
    expect(
      inserts(root)
        .map((i) => i.table)
        .sort()
    ).toEqual(["practice_logs", "symptom_logs"]);
  });

  it("reads a file carrying a literal NUL, which ripgrep would skip", () => {
    // The #3206 hazard, planted: a composite-key separator makes a file BINARY to a
    // default grep, so a census that shelled out would pass silently over this
    // insert. Spelled `\u0000` here — the same byte at runtime, and the FILE this
    // test lives in stays plain text, which is what the NUL census asks for.
    const root = corpus({
      "lib/nul-bearing.ts":
        'const key = a + "\u0000" + b;\n' +
        "db.prepare(`INSERT INTO activities (profile_id) VALUES (?)`).run();\n",
    });
    expect(inserts(root).map((i) => i.table)).toEqual(["activities"]);
  });

  it("stays SILENT on the neighbours it must not cry wolf about", () => {
    // A guard that fired on migrations, on tests, or on a compliant insert would be
    // deleted within a week, taking the real guard with it.
    const root = corpus({
      // A migration's one-shot backfill: excluded by directory.
      "lib/migrations/versions/20260101-backfill.ts":
        "db.exec(`INSERT INTO body_metrics (profile_id) SELECT profile_id FROM x`);\n",
      // A test fixture: excluded by directory, .test.ts suffix or not — the DB
      // tier's shared `fixtures.ts` has no suffix, and it seeds tranche rows.
      "lib/__db_tests__/fixtures.ts":
        "db.exec(`INSERT INTO practice_logs (profile_id) VALUES (1)`);\n",
      "lib/__action_tests__/x.test.ts":
        "db.exec(`INSERT INTO activities (profile_id) VALUES (1)`);\n",
      // A page component under app/ that is neither an action nor a route handler.
      "app/(app)/x/page.tsx":
        "const sql = `INSERT INTO symptom_logs (profile_id) VALUES (1)`;\n",
      // An e2e fixture: outside the corpus by root, as the header states. Silence
      // here is the STATED exclusion, not an oversight (#3566 item 1).
      "e2e/seed/training.ts":
        "db.exec(`INSERT INTO activities (profile_id) VALUES (1)`);\n",
      // And COMPLIANT tranche inserts, which must produce no unstamped finding — one
      // under lib/, and one written the way the seeds write them, with the value
      // interpolated from scripts/seed-logged-via.ts and only the COLUMN spelled out.
      "lib/good-write.ts":
        "db.prepare(`INSERT INTO food_log_events (profile_id, logged_via) VALUES (?, ?)`).run();\n",
      "scripts/seed-good.ts":
        "db.prepare(`INSERT INTO body_metrics (profile_id, date, weight_kg, logged_via)\n" +
        "   VALUES (1,?,?, ${VIA_SEEDED})`).run();\n",
    });
    const found = inserts(root);
    expect(found.map((i) => i.file)).toEqual([
      "lib/good-write.ts",
      "scripts/seed-good.ts",
    ]);
    expect(
      found.filter(
        (i) => TRANCHE.has(i.table) && !/\blogged_via\b/.test(i.statement)
      )
    ).toEqual([]);
  });

  it("refuses an absence verdict on a statement wider than its window", () => {
    // THE WINDOW IS NOT THE GUARD. A tranche INSERT whose column list runs past
    // STATEMENT_WINDOW would otherwise be reported as unstamped on the strength of
    // text nobody read — the cry-wolf direction, on legitimate code, which is how a
    // census gets deleted. Planted with a column list padded past the window.
    const columns = Array.from(
      { length: Math.ceil(STATEMENT_WINDOW / 10) + 4 },
      (_, i) => `col_pad_${i}`
    ).join(", ");
    const found = inserts(
      corpus({
        "lib/very-wide.ts":
          "db.exec(`INSERT INTO activities (" +
          columns +
          ", logged_via) VALUES (1)`);\n",
      })
    );
    expect(found).toHaveLength(1);
    // The column IS named — just out of frame — so the naive check reads "unstamped"…
    expect(/\blogged_via\b/.test(found[0].statement)).toBe(false);
    // …and `columnListVisible` is what stops that becoming a verdict.
    expect(truncatedTrancheInserts(found)).toEqual([
      "lib/very-wide.ts: INSERT INTO activities",
    ]);
    // The compliant narrow case still reads as visible, so this is not vacuous.
    const narrow = inserts(
      corpus({
        "lib/narrow.ts":
          "db.exec(`INSERT INTO activities (profile_id, logged_via) VALUES (1, 'page')`);\n",
      })
    );
    expect(columnListVisible(narrow[0].statement)).toBe(true);
  });

  it("does not count a COMMENTED-OUT table as shipped by the migration", () => {
    // #3567 item 4. The tranche is harvested from source TEXT, and a harvest of
    // "every quoted identifier in the block" counted a demoted name that had been
    // commented out — so the migration could ship six columns while this guard read
    // seven, and only the DB tier would notice. This guard exists to make the claim
    // WITHOUT a database, so that direction fails open and had to close.
    const live = `const TRANCHE = [\n  "activities",\n  "body_metrics",\n] as const;\n`;
    expect(trancheFromSource(live)).toEqual(["activities", "body_metrics"]);

    const lineCommented = `const TRANCHE = [\n  "activities",\n  // "body_metrics" — demoted; see #9999\n] as const;\n`;
    expect(trancheFromSource(lineCommented)).toEqual(["activities"]);

    const blockCommented = `const TRANCHE = [\n  "activities",\n  /* "body_metrics" */\n] as const;\n`;
    expect(trancheFromSource(blockCommented)).toEqual(["activities"]);

    // And it stays silent on a comment that quotes no name at all — the ordinary
    // case, which must keep reading exactly the live list.
    const annotated = `const TRANCHE = [\n  // the three that already carry the pointer\n  "activities",\n  "body_metrics",\n] as const;\n`;
    expect(trancheFromSource(annotated)).toEqual([
      "activities",
      "body_metrics",
    ]);
  });

  it("throws rather than reporting green when the corpus collapses", () => {
    // #3566 item 2, planted from the other end: the floor must GATE the verdicts, not
    // sit beside them. `census()` reads the real repo, so the collapse is proved on
    // the walker — an empty corpus is what every absence assertion in this file would
    // otherwise have reported as three greens beside one red.
    const empty = inserts(corpus({ "lib/README.md": "no source here\n" }));
    expect(empty).toEqual([]);
    expect(new Set(empty.map((i) => i.table)).size).toBeLessThan(FLOOR_TABLES);
    // And the real corpus clears the floor, so the gate is a gate and not a wall.
    expect(() => census()).not.toThrow();
  });

  it("scans the TRACKED set the repo census claims to be about", () => {
    // The repo walk and `git ls-files` must not disagree about which source files
    // exist: an untracked scratch file inside a SCANNED root would otherwise let the
    // census report on something no reviewer can see. The root list is shared with
    // the walker, so a root added there is cross-checked here without a second edit.
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z", ...SCANNED_ROOTS], {
        cwd: REPO,
        maxBuffer: 64 * 1024 * 1024,
      })
        .toString("utf8")
        .split("\u0000")
        .filter(Boolean)
    );
    const untracked = sourceFilesUnder(REPO)
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => !tracked.has(rel));
    expect(untracked).toEqual([]);
  });
});
