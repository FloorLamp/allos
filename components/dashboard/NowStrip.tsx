import type { ReactNode } from "react";

// The dashboard "Now" strip (issue #1413, section A) — the cards the moment makes
// most relevant, moved above the user's own grid. Ordinary relevance is capped at
// two; safety surfaces are deliberately uncapped.
//
// This component is a PLACER, not a renderer. Each entry's `node` is the SAME
// server-rendered candidate node the page would have used; the strip never builds a
// bespoke "compact" variant of a card, because a second rendering of the same
// fact is exactly the drift the one-question-one-computation rule forbids one
// level down. What the strip owns is position and the band's layout — nothing
// about what a card SAYS.
//
// Atomic placement has one reading order at every viewport, so Now is one column
// just like Standing and Everything.
//
// Renders NOTHING (not even a wrapper) when nothing is firing — the strip's zero
// state is zero height, never a filler card. See lib/dashboard-relevance.ts for why.

export interface NowStripCard {
  id: string;
  node: ReactNode;
}

export default function NowStrip({
  cards,
  dateLabel,
}: {
  cards: NowStripCard[];
  // The date, shown only below `md` — the desktop PageHeader still carries it, and
  // below `md` that header is gone entirely (#1413 section C), so this is where the
  // day's orientation survives on a phone. Absent → no line.
  dateLabel?: string;
}) {
  if (cards.length === 0) return null;
  return (
    <section
      data-testid="now-strip"
      data-count={cards.length}
      aria-label="Right now"
      className="mb-6"
    >
      {dateLabel && (
        <div
          data-testid="now-strip-date"
          className="mb-2 text-xs font-medium text-slate-500 md:hidden dark:text-slate-400"
        >
          {dateLabel}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 items-start gap-3">
        {cards.map((c) => (
          <div
            key={c.id}
            data-testid={`now-strip-card-${c.id}`}
            className="min-w-0"
          >
            {c.node}
          </div>
        ))}
      </div>
    </section>
  );
}
