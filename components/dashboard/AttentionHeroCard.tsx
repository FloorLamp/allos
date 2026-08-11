"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import Collapse from "@/components/Collapse";
import { useHydrated } from "@/components/useHydrated";
import { CARD_BAND_LABELS, type CardBand } from "@/lib/attention";

// The collapsible shell around the "Needs attention" hero (issue #1413, section B).
//
// WHAT THIS IS ALLOWED TO DO, AND WHAT IT IS NOT (#449 care tier):
//
// The hero is care-tier PUSH — pinned, non-hideable, no dismiss. #1413 refines that
// contract from ALWAYS-FULL to ALWAYS-PRESENT: the vertical cost becomes opt-in, the
// presence and the COUNT never do. Concretely, this component:
//
//   MAY   collapse the item list to a compact pinned line.
//   MUST  keep the heading, the alert glyph, and the count rendered in BOTH states —
//         the collapsed line also names the highest-severity band ("Past due"), so
//         "3 need attention, one of them past due" survives compaction.
//   MUST  keep the toggle two-way and always visible, so no interaction can reach a
//         state with no attention affordance on the page.
//   NEVER renders a dismiss/hide control, and NEVER collapses a safety-locked hero
//         (`locked` — decided upstream by attentionHeroState from the item's own
//         "safety-ungated" lifecycle policy). A locked hero renders expanded with NO
//         toggle at all: a dead control reads as a bug and invites repeat presses.
//
// The header lives HERE rather than in the server component because the collapse
// state drives both halves (the chevron's direction and the band chip appear only
// when collapsed), and splitting one visual row across the client boundary is how
// the two halves start disagreeing. The item rows — which carry inline Server Action
// forms (mark taken, snooze/dismiss, follow-up resolve) — stay server-rendered and
// arrive as `children`, so nothing about the write paths moves to the client.
//
// The body stays MOUNTED while collapsed (that is what lets Collapse animate it),
// but Collapse marks it aria-hidden + visibility:hidden, so the collapsed card's
// buttons are out of both the accessibility tree and the tab order.
//
// One component at every viewport (the shared-content-component rule): the phone is
// where the height matters most, but a desktop reader gets the same control rather
// than a hand-mirrored `md:` branch that would drift.
export default function AttentionHeroCard({
  count,
  topBand,
  locked,
  initialCollapsed,
  saveCollapsed,
  children,
}: {
  count: number;
  topBand: CardBand | null;
  locked: boolean;
  initialCollapsed: boolean;
  saveCollapsed: (collapsed: boolean) => Promise<void>;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // The toggle only works once hydrated. Surfaced so a browser test can wait for
  // the real behavior instead of racing it (the #1416 `data-ready` precedent) —
  // the server-rendered card is fully readable before this flips, it just isn't
  // yet collapsible.
  const ready = useHydrated();

  // How many preference writes have SETTLED, in the `savedAt`-counter shape the
  // app's other autosaving surfaces already use (SaveStatus / useSaveStatus).
  //
  // The toggle deliberately does not revalidate (see the header note), which means
  // there is no server-rendered marker a reader — or a browser test — can use to
  // tell "the preference is stored" from "the click has not reached the server
  // yet". A monotone counter is the race-free way to say it: a caller reads the
  // value, acts, and waits for it to INCREASE. A plain pending/idle boolean is
  // not enough — it starts idle, so an observer can match the pre-click state.
  const [savedCount, setSavedCount] = useState(0);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    // Fire-and-forget for the VIEWER: the UI already reflects the choice, and this
    // only makes it survive a reload. A failed write costs the preference, never
    // the hero — so the counter advances either way (it reports that the attempt
    // settled, not that it succeeded).
    void saveCollapsed(next).finally(() => setSavedCount((n) => n + 1));
  }

  return (
    <section
      data-testid="needs-attention"
      data-collapsed={collapsed ? "true" : "false"}
      data-locked={locked ? "true" : "false"}
      data-ready={ready ? "true" : "false"}
      data-saved-count={savedCount}
      aria-label="Needs attention"
      className="card border-l-4 border-l-brand-500 dark:border-l-brand-400"
    >
      <div
        className={`flex items-center justify-between gap-2 ${
          collapsed ? "" : "mb-3"
        }`}
      >
        <h2 className="flex min-w-0 items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
          <IconAlertTriangle
            className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
            stroke={1.75}
            aria-hidden="true"
          />
          {/* Never truncates: the card's IDENTITY is the last thing that should
              shrink on a narrow phone — "Needs attent…" reads as a broken card,
              not as a compact one. The band chip below is the flexible element. */}
          <span className="shrink-0 whitespace-nowrap">Needs attention</span>
          {/* The count is rendered in BOTH states — this is the #449 invariant the
              collapse is allowed to exist at all because it preserves. */}
          <span
            data-testid="attention-count"
            className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
          >
            {count}
          </span>
          {/* Collapsed only: the highest-severity band, so the compact line still
              says how bad it is and not merely how many. Redundant when expanded —
              the band headings are right there. */}
          {collapsed && topBand && (
            <span
              data-testid="attention-top-band"
              className="min-w-0 truncate text-xs font-medium text-slate-500 dark:text-slate-400"
            >
              {CARD_BAND_LABELS[topBand]}
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {/* The label gives way to its arrow on the narrowest screens so the
              heading + count + band keep the room. The accessible name is on the
              link either way, so nothing is lost to a screen reader. */}
          <Link
            href="/upcoming"
            aria-label="View all needs attention"
            className="inline-flex shrink-0 items-center gap-0.5 text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            <span className="hidden sm:inline">View all</span>
            <IconArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          {/* Absent for a safety-locked hero — see the header note. */}
          {!locked && (
            <button
              type="button"
              onClick={toggle}
              data-testid="attention-collapse-toggle"
              aria-expanded={!collapsed}
              aria-controls="attention-hero-body"
              aria-label={
                collapsed
                  ? "Expand needs attention"
                  : "Collapse needs attention"
              }
              title={collapsed ? "Expand" : "Collapse"}
              className="rounded-md p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
            >
              {collapsed ? (
                <IconChevronDown className="h-4 w-4" />
              ) : (
                <IconChevronUp className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
      <Collapse open={!collapsed}>
        <div id="attention-hero-body">{children}</div>
      </Collapse>
    </section>
  );
}
