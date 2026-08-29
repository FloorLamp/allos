# Why a vitest test times out with nothing failing

Four files across both non-browser tiers went red with `Test timed out in …` and
no assertion failing, twice on CI runners (#3986, #3952). Five lanes each paid for
the same diagnosis. This is what the measurements say.

## The cause

**A test's wall time on CI is a reading of how much CPU its worker got, and that
reading disperses 3-4x between runs of the same commit. Three of these ceilings
had been derived from a SOLO run on a quiet local box, so their real headroom was
1.0-1.2x, not the 3.9-4.4x `vitest.timeouts.ts` claimed.**

The tier is not slower on a bad run. The work is dealt out differently.

| measurement                                           | red        | green      | ratio |
| ----------------------------------------------------- | ---------- | ---------- | ----- |
| pure tier, total test time, 43bdc712 attempts 1 and 2 | 420 158 ms | 408 970 ms | 1.03  |
| `nav-routes.test.ts`, same two runs                   | 16 919 ms  | 12 746 ms  | 1.33  |
| `strip-comments.test.ts`, same two runs               | 118 279 ms | 118 700 ms | 1.00  |
| test-db, 733 common files, total                      | 174 079 ms | 123 909 ms | 1.40  |
| `migration-snapshot.test.ts`, two runs                | 3 167 ms   | 1 017 ms   | 3.11  |
| `restore.test.ts`, two runs                           | 1 793 ms   | 500 ms     | 3.59  |

The two attempts at 43bdc712 are the same commit on the same runner image five
minutes apart. The whole tier moved 3%; individual files moved 33%, and in the DB
tier individual files move 3-4x between two runs that were both **green**.

`test-unit`'s job time over 59 sampled runs is a median 231 s, p90 243, max 257;
`test-db` 185/192/209. Job time is stable. Per-test time is not. The old
derivation read the first number and inferred the second.

## Where the dispersion comes from

Both configs declare projects on **two pools** — `threads` for the shared
projects, `forks` for the isolated ones (vitest's default pool, which
`pure-isolated` and `db-isolated` never override). Vitest runs pools concurrently
and sizes each independently to `availableParallelism()`. On a 4-vCPU
`ubuntu-latest` runner that is up to **8 workers plus the vitest main process**,
and neither config caps it (verified: `maxWorkers` and `poolOptions` resolve
`undefined` on all five projects). The DB tier adds the `node --import tsx`
children `dirty-seed-shape` and `one-cycle-seed-shape` spawn — 56-65 s of that
tier's wall clock is one file blocking in `spawnSync`.

Vitest packs files onto workers dynamically, so **which files are co-resident when
a heavy one runs is a property of the run, not of the commit.** That is why it
fires intermittently, and why the population looked arbitrary: it is not arbitrary,
it is whichever test with thin headroom drew a bad neighbour set.

## The population, ranked by the headroom it actually had

| test                                     | solo      | CI green   | ceiling        | headroom  |
| ---------------------------------------- | --------- | ---------- | -------------- | --------- |
| `strip-comments` oracle sweep            | 18 142 ms | 118 700 ms | 120 000        | **1.01x** |
| `nav-routes.test.ts:332`                 | 2 687 ms  | 12 746 ms  | 15 000         | **1.18x** |
| `migration-reentry` first test           | 3 004 ms  | 3 505 ms   | 15 000         | 4.3x      |
| `dirty-seed-shape` (whole file, 8 tests) | 67 945 ms | 65 193 ms  | 30/40 000 each | —         |

The four named files are the four tightest in the tree. `strip-comments` used
98.9% of its ceiling on **every** CI run and had never crossed; it was the next
main-red, not a survivor.

## What changed, and why

- Ceilings for those tests are now derived from the **CI** reading, with the
  reading written beside each one, and stated as `perTestCeiling(n)` — a multiple
  of the tier ceiling — so `ALLOS_VITEST_TIMEOUT_MS` reaches them. A hard-coded
  `}, 30_000)` was immune to the one lever the harness offers, which is how the
  file that failed most on the dispatch box was the file the lever could not reach.
- The tier default stays **15 000 ms**. It is honest for the 17 395 pure and 6 930
  DB tests that finish inside a second, and raising it would spend the hang
  detector on all of them to rescue three.
- Every test in both tiers now reports what a timeout **was**
  (`vitest.timeout-report.ts`). It measures the test's own event loop and prints
  one line: idle means it was WAITING (an await that never settles, fake timers
  over a real-time await); busy means it was RUNNING and either grew or lost the
  CPU. Measured on a probe: an unresolved promise leaves utilization at 0.006, a
  spin at 1.0. Nothing prints on a green run.

## What is still open

- The 8-workers-on-4-cores overlap is unfixed. `sequence.groupOrder` would
  serialise the two pools; it could not be A/B'd on the dispatch box, where
  ambient load from sibling lanes swamps the effect.
- `strip-comments`' oracle sweep is 119 s — half of `test-unit`'s 231 s median —
  and the pure tier has a family of whole-tree scanners that each independently
  re-read and re-strip the entire source tree.
- #3952's `EnvironmentTeardownError` is a **different** event: its run reported
  `6898 passed` with `Errors 1 error` and no failing test at all. The signal above
  does not reach it, because no test timed out.
