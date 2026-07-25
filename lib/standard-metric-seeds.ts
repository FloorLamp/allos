import type Database from "better-sqlite3";

// The DEFAULT-SAVED standard metric tiles (issue #1487, data half).
//
// #1456 gave `saved_items` kind `trend-metric` PROMOTION semantics: every standard
// metric tile rendered on Trends Overview whether or not it was saved, and a save
// only ordered it first. #1487 graduates that to MEMBERSHIP — Overview will render
// what you saved and what changed, nothing unconditional — which only works if the
// standard tiles already exist as saved rows. So they become SEEDS: real
// `saved_items` rows a user can unstar like anything else.
//
// This module is the ONE runtime seeding core (migration 114 carries a frozen copy
// of the same insert for profiles that predate it — a shipped migration may never
// import lib/, so the duplication is deliberate and the DB tier pins the two
// against each other).
//
// It takes the `Database` handle rather than importing lib/db, so lib/migrations/
// boot-tasks.ts can call it during bootstrapAuth: boot-tasks sits on the lib/db
// boot path, and a `lib/db` import here would close the db → boot-tasks → db cycle
// the boot-tasks header warns about.
//
// SEEDING IS CREATE-TIME ONLY, NEVER A PER-BOOT TASK. Re-running it against a live
// profile would resurrect a metric the user deliberately unstarred — the #203
// class of bug (state keyed to a subject outliving the user's decision about it).
// The two production callers are the two production profile-creation paths:
// bootstrapAuth (profile 1) and createProfile (Settings → Family); migration 114
// covers every profile that already existed.

// The standard Overview metric ids, in TILE ORDER — the order METRIC_DEFS in
// lib/trends-series.ts builds them, which is the order they render in today. Seeds
// are ordered to match, so a never-curated profile's tile sequence after seeding is
// exactly the sequence it had before (the byte-identical guarantee; pinned by
// lib/__db_tests__/standard-metric-seeds.test.ts, which asserts this list against
// buildMetricSeries itself rather than trusting the copy).
export const STANDARD_TREND_METRIC_IDS: readonly string[] = [
  "weight",
  "bodyfat",
  "resting_hr",
  "volume",
];

// SEEDS ARE UNPOSITIONED AND STAMPED OLDER THAN ANY REAL SAVE. That is what makes
// them invisible in the ordering, and it is the whole trick of this change.
//
// The saved order (orderSavedRefs) is: explicitly positioned rows first, ascending;
// then unpositioned rows newest-first by `created_at`. Two consequences decide the
// design:
//
//   • Giving the seeds POSITIONS would sort them ahead of every unpositioned row —
//     i.e. ahead of the user's own plain ★ saves, and ahead of every star they make
//     LATER. A newly starred biomarker would land behind the four standard metrics
//     instead of at the front of the grid, which is not where it lands today.
//   • Leaving them unpositioned with a normal `created_at` would make them the
//     NEWEST saves, sorting them ahead of existing stars for the same reason.
//
// So they are unpositioned and carry a sentinel `created_at` at the epoch, stamped
// DESCENDING so that "newest first" within the seeds reproduces tile order. Every
// real save — past or future — is newer, so it sorts ahead of them. The seeds read
// as what they are: the tiles you have always had, behind everything you chose. It
// also means seeding REWRITES NOTHING: no existing row's position or timestamp is
// touched, so a profile's own curation survives byte-for-byte.
//
// `created_at` is ordering input only (lib/queries/saved.ts, lib/queries/medical.ts);
// it is never rendered, so the sentinel cannot surface as a bogus "saved on" date.
const SEED_EPOCH_DAY = "1970-01-01";

function seedCreatedAt(index: number, total: number): string {
  // Descending seconds: the first tile is the newest seed, the last the oldest.
  const seconds = total - index;
  const hh = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${SEED_EPOCH_DAY} ${hh}:${mm}:${ss}`;
}

// Seed one profile's standard metric saves. Idempotent: a second call is a pure
// no-op, and it never touches a row that already exists — an OR IGNORE against the
// store's UNIQUE(profile_id, kind, key). A metric the user had already saved keeps
// its own row, its own position and its own real `created_at`, so existing curation
// is left exactly as it was.
export function seedStandardMetricSaves(
  db: Database.Database,
  profileId: number
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key, position, created_at)
       VALUES (?, 'trend-metric', ?, NULL, ?)`
  );
  STANDARD_TREND_METRIC_IDS.forEach((id, i) => {
    insert.run(
      profileId,
      id,
      seedCreatedAt(i, STANDARD_TREND_METRIC_IDS.length)
    );
  });
}
