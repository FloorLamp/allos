// THE ONE THING BOTH NON-BROWSER TIERS ADD TO EVERY TEST (#3986).
//
// A timeout and an assertion failure are different events that read identically in
// a tier's summary, and five lanes each paid for the same diagnosis before anyone
// wrote this down. The reporter cannot tell them apart — by the time it has the
// task, all it has is an error message — so the distinction is drawn HERE, in the
// worker, where the test's own event loop can still be measured.
//
// It prints only when a test times out, so the line cannot be trained away by
// appearing on green runs. The classification itself lives in vitest.timeouts.ts
// beside the ceilings it is about, and is unit-tested there without forging a
// timeout, so nothing in the log is ever a fixture's copy of this line.
import { afterEach, beforeEach } from "vitest";
import { performance } from "node:perf_hooks";
import { describeTimeout, testTimeout } from "./vitest.timeouts";

let started = 0;
let loopAtStart: ReturnType<typeof performance.eventLoopUtilization>;

beforeEach(() => {
  started = performance.now();
  loopAtStart = performance.eventLoopUtilization();
});

afterEach((ctx) => {
  const loop = performance.eventLoopUtilization(loopAtStart);
  const line = describeTimeout({
    message: ctx.task.result?.errors?.[0]?.message,
    ceilingMs: ctx.task.timeout ?? testTimeout,
    wallMs: performance.now() - started,
    utilization: loop.utilization,
  });
  if (line) console.error(line);
});
