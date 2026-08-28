import NowCards, { type NowStripCard } from "./NowCards";

export type { NowStripCard };

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
// just like Standing, Ahead, and Show everything.
//
// Empty remains a real landmark: a quiet sentence, never a filler card or a
// synthetic candidate. The mobile date stays here because the PageHeader is hidden.

export default function NowStrip({
  cards,
  dateLabel,
  bootstrapClaim,
}: {
  cards: readonly NowStripCard[];
  /** Passed straight through — see NowCards. */
  bootstrapClaim?: boolean;
  // The date, shown only below `md` — the desktop PageHeader still carries it, and
  // below `md` that header is gone entirely (#1413 section C), so this is where the
  // day's orientation survives on a phone. Absent → no line.
  dateLabel?: string;
}) {
  return (
    <section
      data-testid="now-strip"
      data-count={cards.length}
      aria-labelledby="dashboard-now-title"
      // Tighter under the strip on a phone (#3460): the strip is the tallest block
      // on the page there, and every unit it keeps pushes the first reading further
      // down. Desktop keeps the section rhythm it has.
      className="mb-4 sm:mb-6"
    >
      {/* Now was the ONLY zone without a visible label (#3238): Standing and Ahead
          both render an h2, so the strip's cards read as orphaned fragments floating
          between the page header and "Standing". Same scale as its siblings, and the
          section's accessible name still says "Right now" — it now comes from the
          heading rather than from an aria-label repeating it. */}
      <h2
        id="dashboard-now-title"
        className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        Right now
      </h2>
      {dateLabel && (
        <div
          data-testid="now-strip-date"
          className="mb-2 text-xs font-medium text-slate-500 md:hidden dark:text-slate-400"
        >
          {dateLabel}
        </div>
      )}
      {/* The cards (and the empty sentence) move one level down into a CLIENT
          component: whether a card's arrival was witnessed is a question only the
          client can answer (#3253 decision 4), and the kind glyph rides in the same
          wrapper. Both stay DIRECT children of this section — the grid and the
          sentence are addressed positionally by specs. */}
      <NowCards cards={cards} bootstrapClaim={bootstrapClaim} />
    </section>
  );
}
