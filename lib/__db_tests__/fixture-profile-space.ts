// THE FIXTURE PROFILE ID SPACE for both DB-tier projects (#2670).
//
// A test file's DATABASE is private — a fresh copy of the migrated template
// (setup-shared.ts) or a fresh boot (setup.ts). Its FILESYSTEM is not. Every
// media store resolves its root from `process.cwd()`, which is the repository
// root for every file in both projects at once:
//
//   data/uploads/progress-photos/<profileId>/
//   data/uploads/lesion-photos/<profileId>/
//   data/uploads/symptom-photos/<profileId>/
//   data/uploads/symptom-videos/<profileId>/
//   data/uploads/activity-videos/<profileId>/
//   data/uploads/medical/<profileId>/
//
// so the ONLY thing separating one file's fixture files from another's is the
// profile id in that path. The template holds exactly one profile (the bootstrap
// admin, id 1), so before this module EVERY file's first fixture profile was id
// 2 and each of those trees was one directory shared by the whole tier. A spec
// cleaning up after itself — `rm -rf <domainRoot>/2`, which six of them do —
// emptied a concurrently running neighbour's fixture directory, and the victim
// then read its own rows back against files that had been deleted out from under
// it. Nobody is wrong alone: each spec writes what it owns and removes what it
// wrote. This is the #2650 collision class one tier down, over a shared
// DIRECTORY rather than a shared database, and it needs no co-residency to bite
// — only two files in flight at once, which is every run.
//
// The fix is that a test file OWNS its per-profile directories, by owning a
// private block of profile ids. `profiles.id` is AUTOINCREMENT, so the block is
// installed by raising `sqlite_sequence` on the file's own database before its
// first insert. No spec changes, and a spec written tomorrow is covered without
// knowing this file exists — which is the whole reason this is not a registry of
// today's six media specs.
//
// THE BLOCK IS KEYED ON (process id, thread id) AND NOTHING ELSE, because that
// pair is what makes it collision-free BY CONSTRUCTION rather than by luck: a
// given (process, thread) runs exactly one test file at a time, so two files
// that are live at the same moment are always in different blocks — across the
// two projects (the shared project's threads and the isolated project's forks
// run in one invocation), and across two vitest invocations sharing one working
// tree. Sequential files within one thread DO reuse a block, and that is safe
// for the same reason it is unique: the earlier file's `afterAll` has already
// run before the next file is imported.

import { threadId } from "node:worker_threads";

/**
 * Fixture profiles one test file may allocate. Generous: the widest media spec in
 * the tier allocates ~25.
 */
export const FIXTURE_PROFILE_BLOCK = 1_000;

/**
 * Threads one process may have. This is a MULTIPLIER, not a wrap — a modulo here
 * would hand a recycled worker thread the block of a live one, which is the bug
 * this module exists to remove. Exceeding it throws instead.
 */
const THREADS_PER_PROCESS = 10_000;

/**
 * The first id in this (process, thread)'s block. The next profile inserted into
 * a database that has had `installFixtureProfileSpace` applied gets `base + 1`.
 *
 * The arguments exist for the census test; production callers pass neither.
 */
export function fixtureProfileBase(
  pid: number = process.pid,
  thread: number = threadId
): number {
  if (thread < 0 || thread >= THREADS_PER_PROCESS) {
    throw new Error(
      `fixture profile space: thread ${thread} is outside the ${THREADS_PER_PROCESS}-thread span; widen THREADS_PER_PROCESS`
    );
  }
  const base = (pid * THREADS_PER_PROCESS + thread) * FIXTURE_PROFILE_BLOCK;
  if (!Number.isSafeInteger(base + FIXTURE_PROFILE_BLOCK)) {
    throw new Error(
      `fixture profile space: block for pid ${pid} thread ${thread} exceeds the safe integer range`
    );
  }
  return base;
}

interface SequenceDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
}

/**
 * Move `handle`'s profile id allocation into this (process, thread)'s block.
 *
 * Idempotent, and it only ever RAISES the sequence: a database that somehow
 * already holds a higher profile id keeps allocating above it, because
 * AUTOINCREMENT may not hand back an id that is already taken.
 */
export function installFixtureProfileSpace(handle: SequenceDb): void {
  const base = fixtureProfileBase();
  const { max } = handle
    .prepare("SELECT COALESCE(MAX(id), 0) AS max FROM profiles")
    .get() as { max: number };
  if (base <= max) return;
  const updated = handle
    .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'profiles'")
    .run(base).changes;
  if (updated === 0) {
    // No AUTOINCREMENT insert has happened on `profiles` yet, so the row the
    // UPDATE looks for does not exist. (The template always has one; a
    // freshly-booted isolated database may not.)
    handle
      .prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('profiles', ?)")
      .run(base);
  }
}
