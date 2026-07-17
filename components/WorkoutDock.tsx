"use client";

import { useEffect, useState } from "react";
import { IconBarbell, IconChevronUp } from "@tabler/icons-react";

// The app-wide minimized workout dock (issue #921): a full-width bottom bar that
// keeps an in-progress session visible from every page (except the training log,
// where the editor docks inline). It renders over the mobile bottom nav; the app
// layout adds bottom padding while it's present so it never overlaps content.
//
// Purely presentational — it shows the state derived server-side (elapsed from the
// session's start) and ticks the minute counter locally. The whole bar is one tap
// target that (re)opens the live editor; there are no inline controls in v1. A live
// session gets a filled brand-accent treatment so a running workout is unmistakable
// at a glance; a stale session (quiet a while) softens to a "finish or discard"
// suggest (#560) — suggest-only, the tap opens the editor to finish, never auto-ends.
export default function WorkoutDock({
  label,
  startEpochMs,
  live,
  stale,
  ownerName,
  onOpen,
}: {
  // The current exercise / session title, already resolved server- or client-side.
  label: string;
  // Absolute epoch (ms) the session started — the elapsed minutes tick off this.
  startEpochMs: number;
  // Live workout mode → the colored treatment; a plain open draft stays neutral.
  live: boolean;
  // The draft has gone quiet past the stale threshold → the finish-or-discard suggest.
  stale: boolean;
  // Set when the dock belongs to a DIFFERENT profile than the acting one (#531): the
  // owner's name is shown so it can't read as the acting profile's workout.
  ownerName?: string | null;
  onOpen: () => void;
}) {
  const [elapsedMin, setElapsedMin] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startEpochMs) / 60_000))
  );
  useEffect(() => {
    const tick = () =>
      setElapsedMin(
        Math.max(0, Math.floor((Date.now() - startEpochMs) / 60_000))
      );
    tick();
    const h = setInterval(tick, 20_000);
    return () => clearInterval(h);
  }, [startEpochMs]);

  const tone = stale
    ? "bg-amber-500 text-white dark:bg-amber-600"
    : live
      ? "bg-brand-600 text-white dark:bg-brand-500"
      : "bg-slate-700 text-white dark:bg-slate-600";

  const who = ownerName ? `${ownerName} · ` : "";
  const primary = stale ? `${who}Still working out?` : `${who}${label}`;
  const secondary = stale ? "Finish or discard" : `${elapsedMin} min`;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 px-[max(0.5rem,env(safe-area-inset-left))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 print:hidden"
      data-testid="workout-dock"
    >
      <button
        type="button"
        onClick={onOpen}
        data-testid="workout-dock-open"
        className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left shadow-lg transition-opacity hover:opacity-95 ${tone}`}
      >
        <IconBarbell
          className="h-5 w-5 shrink-0"
          stroke={1.75}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {primary}
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums opacity-90">
          {secondary}
        </span>
        <IconChevronUp
          className="h-4 w-4 shrink-0 opacity-80"
          stroke={2}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
