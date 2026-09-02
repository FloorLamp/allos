import NowCards, { type NowStripRow, type NowSubjectLabel } from "./NowCards";

export type { NowStripRow, NowSubjectLabel };

// The dashboard "Now" strip (issue #1413, section A) — the facts the moment makes
// most relevant, above the user's own grid. Ordinary relevance is capped at two;
// safety surfaces are deliberately uncapped.
//
// This component is a PLACER, not a renderer. What it owns is position and the
// band's layout — nothing about what a row SAYS.
//
// SINCE #4076 IT PLACES ROWS, not cards: every zone renders the one columnar row
// grammar, so Now is a band of rows exactly like Standing and the tail, and the
// per-card kind glyph that used to ride in a desktop gutter beside them is gone with
// the cards it named (owner: "too many icons").
//
// The illness cockpit is the one node here that is not a fact but a running
// SITUATION with its own controls, and it keeps its own group rendering above the
// rows — its episodes' facts still place, so completeness is unchanged.
//
// Empty remains a real landmark: a quiet sentence, never a filler row or a synthetic
// candidate. The mobile date stays here because the PageHeader is hidden.

export default function NowStrip({
  rows,
  dateLabel,
  bootstrapClaim,
}: {
  rows: readonly NowStripRow[];
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
      data-count={rows.length}
      aria-labelledby="dashboard-now-title"
      // Tighter under the strip on a phone (#3460): the strip is the tallest block
      // on the page there, and every unit it keeps pushes the first reading further
      // down. Desktop keeps the section rhythm it has.
      className="mb-4 sm:mb-6"
    >
      {/* Now was the ONLY zone without a visible label (#3238): Standing and Ahead
          both render an h2, so the strip's rows read as orphaned fragments floating
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
      {/* The rows move one level down into a CLIENT component: whether a row's
          arrival was witnessed is a question only the client can answer (#3253
          decision 4). It stays a DIRECT child of this section — the band and the
          sentence are addressed positionally by specs. */}
      <NowCards rows={rows} bootstrapClaim={bootstrapClaim} />
    </section>
  );
}
