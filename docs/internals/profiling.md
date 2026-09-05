# Profiling a page over real data

Two scripts, one harness, no production access from the code.

## What exists

| Piece              | File                                                                               | Reads                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The render harness | `lib/__db_tests__/dashboard-render-harness.ts`                                     | fakes the request (session, scope, request cache, the two side effects) so `Dashboard()` renders in a test process                                |
| The query meter    | `lib/__db_tests__/dashboard-placement-manifest.test.ts`                            | statements per persona against a budget, and each `hr_minutes` range read against the window it was bound to; runs in `npm run test:db`           |
| The tick meter     | `lib/__db_tests__/tick-gather-budget.test.ts`                                      | statements per persona for the digest and recap GATHERS, with no request cache — the lifetime the notify sidecar actually runs under (#5199)      |
| The profiler       | `lib/__db_tests__/dashboard-profile.test.ts` behind `scripts/profile-dashboard.ts` | wall time, per-statement time with the app frame that ran it, and a V8 CPU profile, over a copy of any database; skipped unless `PROBE_DB` is set |
| The page timer     | `scripts/time-page.mjs`                                                            | a real browser's time-to-first-byte for a path on a running server                                                                                |

The meter and the profiler render through the same harness, so what one counts is what the other times. Either reading changing the harness changes both.

## Profiling the dashboard

1. Take a read-only snapshot of the database you want to measure (production: `VACUUM INTO` a copy, never the live file, and rewrite the admin login if you will also run the server).
2. `npm run profile:dashboard -- --db <snapshot> --profile <id> --now <iso instant>`. The script copies the file first (a render may write), runs one warm-up render and `--renders` profiled ones, and prints renders, statements by time, SQLite time by caller, and the CPU profile's self time by function and file plus inclusive time for app frames. Everything lands under `--out` (default `data/profiles/dashboard-<stamp>/`): `summary.txt`, `profile.json`, `render.cpuprofile` (open in a browser's Performance panel), `vitest.log`.
3. Any other page: `--page "app/(app)/trends/page" --params '{"tab":"overview"}' --route-params '{"id":"417"}'`. The probe resolves the page's async component tree itself (there is no React server renderer in this tier), so streamed sections are measured; client components that reach for a hook are skipped and listed, and their children are walked as if the wrapper were transparent. A page that reads Next's request APIs directly fails with that message in `vitest.log`.
4. For wall-clock as a browser sees it: `ALLOS_DB_PATH=<a writable copy> npm run dev -- -p 3123`, then `node scripts/time-page.mjs --base http://localhost:3123 --path / --runs 6`. The dev log prints `application-code:` per request beside the browser's numbers; against `next dev` discount the first run.

## Reading it

- **Time in SQLite versus wall** is the first split. #5010's first reading was 0.24 s in SQLite against a 2.6 s render: the cost was per-row timezone conversion in JavaScript, not queries.
- **Statements by caller** names the gather; **inclusive time by app frame** names the reader above it. The two together say whether the fix is a query, a memo, or a projection.
- **A hot file is not a diagnosis.** `--attribute lib/foo.ts` (repeatable) splits that file's self time by leaf frame and by the caller outside it, and prints a SUM against the file's total — attribution that does not sum is partial, and a partial one reads exactly like a complete one. #5061 used it to find that `lib/local-day-window.ts` was 100% the per-row projection and 0% the transition search everyone suspected, and that `lib/training-zones.ts` was one scoping pass run twice on identical inputs rather than the twelve-week window the issue named.
- **Line numbers in the CPU profile are the transformed module's**, not the source file's (vitest's transform, no source map applied); read them as "near", and open `render.cpuprofile` in a browser for the exact frame. Two rows are the harness, not the app: `ClockDate` (the tier's frozen clock wrapping `Date`) and `node:inspector`.
- **A statement count cannot tell reads apart.** Three reads of three windows and three reads of one window both print 3, so the trace can be told to keep a statement's parameters (`installStatementTrace({ bindings })`) and the meter keys the heart-rate range read on the span it was bound to, while the profiler prints those spans under `hr_minutes windows read`. Since #5034 the `biohacker` persona seeds an all-day heart-rate trace — 43,200 minute buckets over the thirty nights it already records — so the meter's own six now reach that seam; the dedicated fixture profile stays because it is the positive control that reds if they ever stop.
- **The statement count** is the meter's number; the profiler reports it so a change can be checked against the budget in the same run.

The clean-up rule from the throwaway that preceded this: never `pkill -f` a pattern that matches your own shell command, and never point the profiler at the live `data/allos.db`.
