"use client";

import { useEffect, useRef } from "react";

// SEEING THE WRITE LAND (#5435 §6.3, §5.2).
//
// Home is a logging page with a glance attached, and the Now band sits between the
// Quicklogger door and the record. So on a phone the row a just-closed sheet created is
// very often BELOW the first screen: the write succeeded, the page re-rendered, and the
// person saw nothing move. This brings that row into view and marks it briefly.
//
// IT READS THE RECORD, NOT THE WRITE. There is no write channel here and deliberately
// so — an offline write is queued by the sheet and replayed later, and nothing on Home
// may represent a queued write (§6.3). What this watches is the newest row the SERVER
// rendered: when that id changes between renders, a write has actually landed in the
// record, whichever surface made it. A queued one changes nothing until it replays, at
// which point it gets its receipt like any other.
//
// AND IT IS SILENT ON FIRST PAINT. The first render establishes the baseline rather than
// announcing it: every visit would otherwise scroll to and flash the last thing the
// person logged, hours ago, as if it had just happened.
//
// THE TELEGRAM HANDOFF (§6.2) IS NOT THIS. A nudge's open-in-app link lands on Home with
// the row contract's own id as the URL fragment, which the browser already scrolls to
// and the rows already mark with a `target:` style — no scheme, no script, and nothing
// here to keep in step with it.
const HIGHLIGHT_MS = 2000;
const HIGHLIGHT_CLASSES = ["bg-(--accent-soft)", "transition-colors"];

export default function HomeReceipt({ rowId }: { rowId: string | null }) {
  // The row id this component has already accounted for. `undefined` means "no render
  // seen yet", which is what separates the baseline from a change.
  const seen = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const previous = seen.current;
    seen.current = rowId;
    if (previous === undefined || previous === rowId || rowId == null) return;
    const row = document.getElementById(rowId);
    if (!row) return;
    // `block: "center"` rather than the default, so a row near the bottom of a long
    // record does not land under the phone's dock.
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add(...HIGHLIGHT_CLASSES);
    const timer = setTimeout(
      () => row.classList.remove(...HIGHLIGHT_CLASSES),
      HIGHLIGHT_MS
    );
    return () => clearTimeout(timer);
  }, [rowId]);

  return null;
}
