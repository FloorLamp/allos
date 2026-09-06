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
and neither config caps it. To re-take that reading, from the repo root:

```
npx tsx -e 'import { createVitest } from "vitest/node";
const v = await createVitest("test", { config: "vitest.db.config.ts", watch: false });
for (const p of v.projects) { const c = p.config as any;
  console.log(c.name, c.pool, "maxWorkers=" + c.maxWorkers, "poolOptions=" + JSON.stringify(c.poolOptions)); }
await v.close(); process.exit(0);'
```

It printed `pool=threads`/`pool=forks` with `maxWorkers=undefined` and
`poolOptions=undefined` on all five projects across both configs. The DB tier adds the `node --import tsx`
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

## Every remaining literal, and what each one was derived from (#4002)

`ALLOS_VITEST_TIMEOUT_MS` is the harness's one lever, and a hard-coded `}, 30_000)`
is immune to it — so the tests likeliest to need slack on a loaded box were exactly
the ones it could not reach. Twenty sites remained after the sweep above. They are
now either a `perTestCeiling(n, basis)` or gone, and the readings are CI's own,
taken from the `test-unit` / `test-db` job logs of the green run at `f1742fa6d`.

**Eleven were vestigial.** They were sized against vitest's implicit **5 s** default,
which no longer exists — the tier ceiling is 15 000 ms — and every one of them had
4x or more of margin against its CI reading without any declaration at all. Deleting
the literal is what makes the lever reach them:

| file                       | was            | CI reading (green, f1742fa6d)     | margin at 15 000 |
| -------------------------- | -------------- | --------------------------------- | ---------------- |
| `dispatch-stall` (5 sites) | 20 000         | 8 617 ms / 23 tests, those 5 ~99% | ~4.9x            |
| `jsonl-log-file` (2 sites) | 10 000, 60 000 | 3 803 ms / 9 tests                | ~7.5x            |
| `notify-log-sink`          | 60 000         | 1 785 ms / 16 tests               | ~9.7x            |
| `page-header-coverage`     | 30 000         | 1 443 ms / 9 tests                | ~10x             |
| `stateful-writes`          | 30 000         | 2 359 ms / 13 tests               | ~7x              |
| `zip`                      | 30 000         | 2 016 ms / 7 tests                | ~9x              |
| `delegated-card-css`       | 120 000        | 1 801 ms / 1 test                 | ~8x              |
| `tick-cadence`             | 45 000         | 333 ms / 2 tests                  | ~45x             |

**One was too THIN, not too generous, and was later retired.** `native-dialogs`
walked app/** and components/** with the TypeScript AST under coverage: 12 427 ms for
the file on CI, which the dispatch box split 62/38 — about 7 700 ms for the larger
scan against a 15 000 ms ceiling. That was 1.9x, not ~4x, so it first moved to
`perTestCeiling(2)`. The scanner is now gone: ESLint's existing AST pass owns both
the native `alert`/`confirm`/`prompt` prohibition and the Playwright dialog-handler
prohibition, so the pure tier no longer reparses the same trees to answer them.

**`migration-reentry` was derived from the wrong reading.** #3999 took the 3 505 ms
green run and recorded, in the same comment, that the test had crossed 15 000 ms on
`main` at `11c7920b`. Against the observed worst that ceiling was 2x, on the one test
whose work grows with every merge. It is now `perTestCeiling(4)`.

**So `perTestCeiling` takes the basis as an argument.** A multiple derived from a
green reading and one derived from an observed worst case are different claims and
used to look identical in the source; `basis` is `"worst"` or `"green"`, it does no
arithmetic, and it is a REQUIRED parameter, so a caller that omits the sentence does
not compile. Where only a green reading exists, the source now says so.

Two sites are deliberate exceptions. `chart-empty-states`' `CHART_CHUNK_WARMUP_MS`
bounds a `findByText` INSIDE a hook, so it must stay BELOW the hook budget rather
than scale with it. `dashboard-placement-manifest`'s hook has no CI reading at all —
it runs in the `db-isolated` pool, whose lines fall outside the window `test-db`'s
job log returns — so its multiple is stated as green-basis and unmeasured on CI.

## What is still open

- `sequence.groupOrder` now runs the shared threads pool before the isolated
  forks pool (#4000), so one Vitest process no longer sizes two simultaneous
  pools against all four runner CPUs. The CI A/B used three grouped samples and
  three exact-tree ungrouped `test-unit` samples (plus two exact-tree ungrouped
  `test-db` samples):

  | reading                   | ungrouped | grouped  | verdict    |
  | ------------------------- | --------- | -------- | ---------- |
  | `test-unit` job median    | 234 s     | 186 s    | 21% faster |
  | `test-unit` Vitest median | 218.07 s  | 169.85 s | 22% faster |
  | `strip-comments` median   | 32.741 s  | 25.545 s | 22% faster |
  | `nav-routes` median       | 12.002 s  | 8.777 s  | 27% faster |
  | `test-db` job median      | 195 s     | 184 s    | 6% faster  |
  | `test-db` Vitest median   | 176.89 s  | 170.04 s | 4% faster  |

  The per-file ranges did **not** tighten uniformly: the unit scanners still
  moved with their neighbours inside the threads pool, and `migration-reentry`
  was 3.367-8.042 s across grouped runs. Snapshot/restore tightened relative to
  #3986's 3-4x sightings, but that is not enough to claim the general dispersion
  mechanism is gone. The whole-job improvement decided the verdict: grouping
  removed cross-pool oversubscription without charging either tier more wall
  time. Dynamic co-residency within one pool remains.

- `strip-comments`' whole-file time is now 24-35 s in the #4000 samples, no
  longer the 119 s recorded above, but the pure tier still has a family of
  whole-tree scanners that independently re-read and re-strip the source tree.
