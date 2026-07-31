import type { ReactNode } from "react";
import type { NowCardId } from "@/lib/now-strip";

// The dashboard "Now" strip (issue #1413, section A) — the one or two cards the
// moment makes most relevant, repeated above the user's own grid.
//
// This component is a PLACER, not a renderer. Each entry's `node` is the SAME
// server-rendered widget node the grid would have used; the strip never builds a
// bespoke "compact" variant of a card, because a second rendering of the same
// widget is exactly the drift the one-question-one-computation rule forbids one
// level down. What the strip owns is position and the band's layout — nothing
// about what a card SAYS.
//
// Layout: two cards share a row from `sm` up, and STACK below it (issue #1547). The
// two-up band is what makes this a compact band rather than a takeover on a screen
// wide enough to hold both — but on a phone a half-width column is the NARROWEST
// column the dashboard has, while the very same widgets render full width in the grid
// below. That inverted the strip's own claim: the moment's most relevant card got the
// least room. `NOW_STRIP_CAP` is 2, so the added mobile height is bounded at exactly
// one card. A lone card takes the full width at every width (a half-width card beside
// dead space reads as a broken grid, not as emphasis). The promoted cards are all
// half-span widgets already, so they are built for the `sm`-and-up column too.
//
// Renders NOTHING (not even a wrapper) when nothing is firing — the strip's zero
// state is zero height, never a filler card. See lib/now-strip.ts for why.

export interface NowStripCard {
  id: NowCardId;
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
      <div
        className={`grid min-w-0 items-start gap-3 sm:gap-6 ${
          cards.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
        }`}
      >
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
