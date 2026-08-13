import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { specsNeedingIsolation } from "@/vitest.isolation";

// SOURCE-SCAN tier — how many specs have bought themselves a PRIVATE MODULE
// REGISTRY, and a ratchet so the answer stops growing quietly.
//
// Both unit tiers run most specs with `isolate: false`: one module graph per
// worker rather than per file. A spec that calls the mock marker (or `process.chdir`,
// or spies on an app module's export through a namespace import) cannot share
// that graph, so `vitest.isolation.ts` routes it to the tier's isolated project,
// where it re-pays the whole graph by itself.
//
// The cost is not marginal. Measured on the DB tier: the isolated project was
// 12.7s of a 28.2s run — 43% of the wall clock for 7% of the files, ~259ms a file
// against 26ms for a shared one.
//
// And nothing was watching it. Twenty of those 49 specs were isolated for the
// SAME reason: each carried its own mock of lib/notifications/telegram-api,
// stubbing the same four primitives. No single one of them was a bad decision —
// there was simply no other way to stub a module, so every spec invented the
// expensive one, and the total grew where nobody was reading it.
//
// There IS another way now, and it is the point of this file's failure message:
// shared spy instances installed by the tier's setup (lib/__db_tests__/
// telegram-spies.ts, lib/__action_tests__/cache-spies.ts), which a spec steers
// with a plain function call. The scan explicitly permits a setup file's own
// mock marker, because it is identical for every file in the tier.
//
// THIS FILE MUST NOT SPELL THE MARKER. `vitest.isolation.ts` decides by scanning
// SOURCE TEXT, so writing the literal call — in a comment, or in the failure
// message below — routes this very file to the isolated project and makes the
// budget it enforces wrong by one. It did, on the first run. Same hazard AGENTS.md
// records for `db.prepare()` inside a comment failing the profile-scoping scan:
// a text scan cannot tell a mention from a use.
//
// This is a BUDGET, not a ban. Some specs genuinely cannot share a registry —
// `process.chdir` is rejected by worker threads outright, and a spec testing a
// module that everything else mocks needs the real one. Raising a number below is
// a legitimate move; doing it without noticing is what this prevents.

// Exact, not an upper bound, so the ratchet turns BOTH ways: adding an isolated
// spec fails until someone states why, and removing one fails until the budget is
// lowered to lock the improvement in. A `<=` would have let the 49 accumulate
// exactly as it did.
const DB_ISOLATED = 29;
const PURE_ISOLATED = 5;

const ADVICE =
  "\n\nAn isolated spec re-pays the whole module graph — ~259ms against ~26ms " +
  "for a shared-registry one, and the DB tier's isolated project was 43% of its " +
  "wall clock for 7% of its files.\n\n" +
  "If you added a spec that mocks a module: consider whether the tier can " +
  "install that mock instead. Shared spy INSTANCES in a setup file " +
  "(lib/__db_tests__/telegram-spies.ts, lib/__action_tests__/cache-spies.ts) are " +
  "the same mock for every file, so the scan allows them, and a spec steers them " +
  "with a plain function call that costs no isolation. Make the default DELEGATE " +
  "to the real module: a stub-by-default mock silently changes what every other " +
  "spec in the tier tests.\n\n" +
  "If the spec genuinely needs its own registry — it calls process.chdir, or it " +
  "tests the very module everything else stubs — then raise the number in " +
  "lib/__tests__/vitest-isolation-budget.test.ts and say which in the message. " +
  "That is a normal thing to do; doing it without noticing is not.";

describe("module-registry isolation budget", () => {
  it("keeps the DB tier's isolated spec count where it was last accounted for", () => {
    const isolated = specsNeedingIsolation(process.cwd() + "/", [
      "lib/__db_tests__",
      "lib/__action_tests__",
    ]);
    expect(
      isolated.length,
      `DB tier isolated specs: expected ${DB_ISOLATED}, found ${isolated.length}.` +
        ADVICE +
        `\n\nCurrently isolated:\n  ${isolated.join("\n  ")}`
    ).toBe(DB_ISOLATED);
  });

  it("keeps the pure tier's isolated spec count where it was last accounted for", () => {
    const isolated = specsNeedingIsolation(process.cwd() + "/", [
      "lib/__tests__",
    ]);
    expect(
      isolated.length,
      `Pure tier isolated specs: expected ${PURE_ISOLATED}, found ${isolated.length}.` +
        ADVICE +
        `\n\nCurrently isolated:\n  ${isolated.join("\n  ")}`
    ).toBe(PURE_ISOLATED);
  });

  it("no DB spec is isolated SOLELY to stub the Telegram primitives", () => {
    // The specific regression this budget was written after. The tier installs
    // that stub itself now (lib/__db_tests__/telegram-spies.ts), so a spec
    // reaching for its own copy has almost certainly not seen it — and the cost
    // is invisible at review time, because the diff just looks like a mock.
    const isolated = specsNeedingIsolation(process.cwd() + "/", [
      "lib/__db_tests__",
      "lib/__action_tests__",
    ]);
    const soleReason = isolated.filter((file) => {
      const src = fs.readFileSync(file, "utf8");
      const mocked = [
        ...src.matchAll(/vi\s*\.\s*(?:doMock|mock)\s*\(\s*["']([^"']+)["']/g),
      ].map((m) => m[1]);
      return (
        mocked.length === 1 &&
        mocked[0] === "@/lib/notifications/telegram-api" &&
        !/process\s*\.\s*chdir\(/.test(src)
      );
    });
    expect(
      soleReason,
      "These specs pay a private module registry only to stub the Telegram " +
        "primitives, which lib/__db_tests__/setup-shared.ts already does for the " +
        "whole tier. Drop the per-spec mock and call stubTelegramSends() in a " +
        "beforeAll instead — the spies delegate to the real module until you do." +
        ADVICE
    ).toEqual([]);
  });
});
