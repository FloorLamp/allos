// SHARED-REGISTRY DB TIER setup (vitest.db-shared.config.ts `setupFiles`).
//
// The isolated tier (setup.ts) gets a fresh module registry per test file, so
// setting ALLOS_DB_PATH at module scope is enough — the hoisted
// `import { db } from "@/lib/db"` in each file opens that file's own database.
//
// This tier runs with `isolate: false`: one worker imports lib/db.ts ONCE and
// reuses it across hundreds of files, which is the whole point (the 178
// migration modules are imported once per worker rather than once per file). The
// cost is that a module-scope env assignment no longer reaches the singleton, so
// per-file isolation has to be re-established explicitly: seed a fresh copy of
// the template and rebind the singleton onto it before each file's tests run.
//
// Only mock-free specs run here. The config excludes every file containing
// vi.mock(), because a shared registry cannot re-mock a module an earlier file
// already evaluated.
import { afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { templateDbPath } from "./shared-template";
import { resetTelegramSpies } from "./telegram-spies";
import { installFixtureProfileSpace } from "./fixture-profile-space";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

// THE OUTBOUND TELEGRAM PRIMITIVES, as shared spies for the whole project.
//
// Twenty specs each carried an identical-in-shape copy of this mock, and a
// `vi.mock` in a SPEC is what routes it to the isolated project — where it
// re-pays the whole module graph, ~10x a shared-registry file. Hoisting it here
// is the move the isolation scan explicitly allows: the same mock for every file
// in the tier, handing back the same spy INSTANCES (./telegram-spies), so nothing
// varies per file and no earlier file's imports go stale.
//
// The spies DELEGATE to the real primitives by default, so installing this
// changes nothing on its own. That is load-bearing: a large class of specs — the
// digest, the notify orchestrators, telegram-api's own wire tests — drives the
// real primitives against a stubbed global `fetch` and asserts there. They never
// mention telegram-api, so a stub-by-default mock breaks them with no clue why.
// A spec that wants the network stopped calls `stubTelegramSends()`, which is a
// plain function call and costs no isolation.
//
// `...actual` is kept: only the four network primitives are wrapped, so
// TelegramApiError, the wire-limit constants and the rest stay real.
vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  const spies = await import("./telegram-spies");
  spies.bindActualTelegramApi(actual);
  return {
    ...actual,
    sendMessageRaw: spies.sendMessageRaw,
    editMessageTextRaw: spies.editMessageTextRaw,
    editMessageReplyMarkupRaw: spies.editMessageReplyMarkupRaw,
    answerCallbackQuery: spies.answerCallbackQuery,
  };
});

// Fresh throwaway database for one test file, copied from the pre-migrated
// template. Returns the directory holding it so the caller can drop it later.
function seedDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "allos-db-shared-"));
  const dbPath = path.join(dir, "test.db");
  fs.copyFileSync(templateDbPath(), dbPath);
  process.env.ALLOS_DB_PATH = dbPath;
  return dir;
}

function discard(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Throwaway directory under os.tmpdir(); a failure to unlink is not worth
    // failing a test file over.
  }
}

// Bootstrap seed: the FIRST file to import lib/db.ts in this worker opens
// whatever ALLOS_DB_PATH says at that moment, which happens before any hook runs.
let activeDir = seedDatabase();

// Module-scope state that outlives a test file once the registry is shared, and
// would otherwise answer the next file with the previous file's data. These live
// here rather than in lib/db.ts: db.ts sits at the bottom of the import graph and
// reaching up into the query layer from it would be a cycle. Each entry needs a
// REASON, and a new module-level cache fed by DB reads belongs on this list.
async function resetCarriedState(): Promise<void> {
  // #2066 dose-schedule history, memoized per profile with a 5s TTL — every
  // seeded file bootstraps the same low profile ids, so a hit from the previous
  // file is indistinguishable from this file's own data.
  const schedule = await import("../queries/intake/schedule");
  schedule.invalidateDoseScheduleVersions();
}

beforeAll(async () => {
  const previousDir = activeDir;
  activeDir = seedDatabase();
  // Statically imported and called with NO await in between: `seedDatabase()`
  // above has just pointed the process-global ALLOS_DB_PATH at this file's copy,
  // and the singleton is not rebound onto it until `reopenDatabaseForTests()`
  // below. Widening that window with a dynamic import is enough to make unrelated
  // specs read a database they did not write to.
  resetTelegramSpies();
  // The MODULE NAMESPACE, not a destructure: `db` is an `export let` that
  // `reopenDatabaseForTests()` reassigns, and a destructured copy would still
  // point at the handle on the PREVIOUS file's database.
  const dbModule = await import("../db");
  // Closes the handle still held on previousDir, which is what makes the
  // directory removable on Windows (an open file cannot be unlinked there).
  dbModule.reopenDatabaseForTests();
  // The DATABASE is private per file; `data/uploads/**` is NOT — every media
  // store resolves its root from the shared cwd, so a per-profile fixture
  // directory belongs to this file only if the profile id does. See
  // ./fixture-profile-space.ts (#2670).
  installFixtureProfileSpace(dbModule.db);
  await resetCarriedState();
  if (previousDir !== activeDir) discard(previousDir);
});

// The rolling discard above can only ever clean the PREVIOUS directory, so the
// LAST one a worker seeds has no later `beforeAll` to drop it — it survives the
// run. One stranded directory per worker per vitest invocation sounds mild; it is
// not, because agents and watch loops invoke vitest constantly. Measured on a
// long-lived container: 13,615 directories, ~15.5 GB, which is the whole writable
// allowance (#2529). CI never noticed because its runners are ephemeral.
//
// The isolated tier (setup.ts) has always torn its directory down here and has
// leaked nothing, which is the A/B that identified this. Same treatment, and the
// same reasoning about safety: unlinking an open file is fine on Linux, and the
// `beforeAll` above has already reopened the singleton onto the NEXT directory by
// the time this file's turn ends. `discard` is force+recursive, so the next
// `beforeAll` re-dropping an already-gone directory is a no-op.
afterAll(() => discard(activeDir));
