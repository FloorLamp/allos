import type { ReactNode } from "react";

// Make a census section GENUINELY stream (#1644).
//
// Wrapping a section in `<Suspense>` is necessary but not sufficient here. Every
// read on this page is SYNCHRONOUS `better-sqlite3`, so a census Server Component
// — `async` though it is — never actually suspends: React resolves the whole tree
// in microtasks and flushes it as one chunk. The boundaries would be decorative,
// the shell would still wait on every domain's chart assembly, and the merged page
// would pay in first paint exactly what the tab strip used to save (#105).
//
// So each census is preceded by ONE macrotask yield. React sees a real suspension,
// flushes the shell it already has — the header, the sticky chips, the range
// control, the digest, the starred grid, and every section's heading and anchor —
// and resumes with the census after the browser has something to paint. The cost is
// one event-loop turn per section; the saving is every domain's queries and chart
// assembly, off the critical path.
//
// It is a WRAPPER rather than a line inside each section so the yield is stated
// once, next to the reason for it, instead of four times as a mysterious `await`.
// WHICH yield matters, measurably. React's server renderer schedules its flushes
// with `setImmediate` (the event loop's CHECK phase); a `setTimeout(…, 0)`
// continuation runs in the earlier TIMERS phase, so the census's synchronous
// SQLite work would resume BEFORE the pending shell flush and block the loop
// through it — measured as ~240ms to first byte instead of ~155ms. Resuming on
// `setImmediate` queues the census behind the flush that is already scheduled.
// `setTimeout` is the fallback for any runtime without it.
function yieldToFlush(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    setImmediate(() => setImmediate(resolve));
  });
}

export default async function StreamedCensus({
  children,
}: {
  children: ReactNode;
}) {
  await yieldToFlush();
  return <>{children}</>;
}
