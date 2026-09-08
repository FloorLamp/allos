// Capture wall time and event-loop utilization in the worker, where they are
// observable. Report test timeouts through the shared policy; ordinary passing
// tests stay quiet. See docs/internals/test-tier-timeouts.md for the limits of
// this diagnostic, including hook failures and multiple reported errors.
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
