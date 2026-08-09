"use client";

import { useEffect } from "react";

// The tint a focused row wears (#2339). One constant, because the records table and
// the read-only produced listing must highlight the SAME way — a reviewer who
// followed a "Check these first" link is looking for one thing on the page and
// should not have to learn two appearances of it.
export const TRIAGE_FOCUS_ROW = "bg-brand-50 dark:bg-brand-950/60";

// Bring the focused row into view after the tab it lives on has rendered.
//
// The link that got here carries the row's LABEL, not a fragment: the row id is
// resolved server-side from the label against the rows that exist right now, so
// there is nothing for the browser's own fragment handling to act on. One
// scroll on mount is enough — this page is fully rendered before it hydrates
// (`force-dynamic`, no streamed boundary), so the target cannot move underneath
// us the way a streamed anchor can (contrast trends/SectionHashScroll).
//
// `block: "center"` scrolls the records table's own overflow container as well as
// the page, which is what a row buried in a 70vh-capped table needs.
export default function TriageFocusScroll({ rowId }: { rowId: string }) {
  useEffect(() => {
    document.getElementById(rowId)?.scrollIntoView({ block: "center" });
  }, [rowId]);
  return null;
}
