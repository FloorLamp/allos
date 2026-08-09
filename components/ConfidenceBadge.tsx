import {
  confidenceLabel,
  type ConfidenceFlag,
  type ExtractionConfidence,
} from "@/lib/extraction-confidence";

// Per-record extraction confidence badge (#1601). Warmer as the extractor's
// certainty drops — rose for the rows to open first, amber for "check it", and a
// muted chip for a row the extractor rated high but that still landed in a flagged
// list (it can't, today, but the map stays total so a vocabulary change can't
// render an unstyled badge).
const CONFIDENCE_BADGE: Record<ExtractionConfidence, string> = {
  low: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  high: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
};

// The badge itself, shared by the import-detail "Check these first" card and by
// the flagged ROW in the records browser (#2339): the same tier must read the same
// way in both places, or the card and the table would appear to disagree about how
// sure the extractor was.
export default function ConfidenceBadge({
  confidence,
  testid,
  className,
}: {
  confidence: ExtractionConfidence;
  testid?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testid}
      className={`rounded px-1.5 py-0.5 text-xs ${CONFIDENCE_BADGE[confidence]} ${className ?? ""}`}
    >
      {confidenceLabel(confidence)}
    </span>
  );
}

// What the extractor hedged about THIS row, rendered on the row itself (#2339).
//
// The reasons are the most useful content the confidence card has — they name a
// real ambiguity a reviewer can settle, and several of them are about information
// the patient knows and the document doesn't state. Until now they appeared ONLY
// in the card, so someone reading the records table saw a value with no hint that
// the extractor hedged on it or why. The row says it itself, so the table is
// self-describing whether or not the reader arrived from the card.
//
// Rendered ONLY where a flag's label resolves to exactly ONE row: a hedge that
// matched two rows describes one of them, and stamping both would state something
// false about one — the same no-guessing rule the link follows.
export function ConfidenceRowNote({ flag }: { flag: ConfidenceFlag }) {
  return (
    <div
      data-testid="row-confidence"
      className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 font-normal"
    >
      <ConfidenceBadge
        confidence={flag.confidence}
        testid="row-confidence-badge"
      />
      {flag.reason && (
        <span className="text-xs italic text-slate-500 dark:text-slate-400">
          {flag.reason}
        </span>
      )}
    </div>
  );
}
