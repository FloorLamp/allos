import type { ReactNode } from "react";

// MAKE A SECTION GENUINELY STREAM BELOW ITS PAGE'S HEAD (#1644, generalised by #2641).
//
// Wrapping an expensive section in `<Suspense>` is necessary but not sufficient here.
// Every read in this app is SYNCHRONOUS `better-sqlite3`, so a section's Server
// Component — `async` though it is — never actually suspends: React resolves the whole
// tree in microtasks and flushes it as one chunk. The boundary would be decorative and
// the shell would still wait on the section's whole query load.
//
// So the section is preceded by ONE macrotask yield. React sees a real suspension,
// flushes the shell it already has — the page header, the tab strip, the controls —
// and resumes with the section after the browser has something to paint. The cost is
// one event-loop turn; the saving is the section off the critical path.
//
// It is a WRAPPER rather than a line inside each section so the yield is stated once,
// next to the reason for it, rather than as a mysterious `await` in a component that
// has nothing to do with streaming.
//
// WHICH yield matters, measurably. React's server renderer schedules its flushes with
// `setImmediate` (the event loop's CHECK phase); a `setTimeout(…, 0)` continuation runs
// in the earlier TIMERS phase, so the section's synchronous SQLite work would resume
// BEFORE the pending shell flush and block the loop through it — measured on the Trends
// census as ~240ms to first byte instead of ~155ms. Resuming on `setImmediate` queues
// the section behind the flush that is already scheduled. `setTimeout` is the fallback
// for any runtime without it.
//
// This lived in `app/(app)/trends/StreamedCensus.tsx` as the pattern's one exemplar
// until #2641 asked for it on the other heavy hubs; it moved rather than being copied.
function yieldToFlush(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof setImmediate !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    setImmediate(() => setImmediate(resolve));
  });
}

export default async function StreamedSection({
  children,
}: {
  children: ReactNode;
}) {
  await yieldToFlush();
  return <>{children}</>;
}

// THE PENDING STATE IS DESIGNED, NOT BLANK, AND IT RESERVES A HONEST HEIGHT (#2641,
// carrying the #2531/#2399 rule across to pending states).
//
// A suspended section that renders nothing is the content-less shell #530 already
// rejected, one section down; a suspended section that reserves the WRONG height is a
// layout jump the moment the content lands, which is the failure this issue names
// explicitly. So the placeholder draws the CARD the section is about to draw, at a
// height stated by the caller in the same vocabulary the surface uses — one heading
// bar and a body block — and says out loud what is arriving.
//
// It is deliberately not a spinner: a spinner says "wait" and says nothing about what
// for. `aria-busy` plus a named live label is what a screen reader needs; the pulse is
// what a sighted reader needs; neither is a claim about how long.
export function PendingSection({
  label,
  bodyClassName = "h-40",
}: {
  /** What is arriving — the section's own heading, verbatim. */
  label: string;
  /**
   * The body block's reserved height, as a Tailwind height class. Pick the one that
   * matches what this section usually lands at: too short jumps the page down when the
   * content arrives, too tall jumps it up.
   */
  bodyClassName?: string;
}) {
  return (
    <div
      className="card animate-pulse"
      data-testid="streamed-section-loading"
      data-section={label}
      aria-busy="true"
    >
      <div className="h-4 w-40 rounded-sm bg-slate-200 dark:bg-ink-800" />
      <div
        className={`mt-4 rounded-sm bg-slate-100 dark:bg-ink-850 ${bodyClassName}`}
      />
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
