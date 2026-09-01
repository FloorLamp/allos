"use client";

import SubstanceUnitControl from "@/components/substances/SubstanceUnitControl";

export interface QuickSubstanceRow {
  key: string;
  label: string;
  logLabel: string;
  /** Null for a substance with no target — see the comment below. */
  capProgress: string | null;
}

// The quick-entry overlay's SUBSTANCE row (issue #3327).
//
// ── Why this row exists at all, given the argument against it ─────────────────
//
// `QUICK_LOG_DOMAIN_CENSUS` argued substance logging OUT of the sheet for two years'
// worth of surfaces: substance use lives under its own page with the #998 cap verdict
// rendered beside the tap, and a sheet row would detach the tap from the context that
// makes it honest. #3279 ruling 1 narrowed that to its real premise — it presumes a
// cap EXISTS — and this list answers both halves rather than assuming either:
//
//   • the ROW is offered only to a profile that has a substance ledger row, so an
//     empty offer is impossible (lib/quick-log.ts, and the server re-gate in
//     app/(app)/quick-entry-actions.ts for a deep link that skipped the row);
//   • the CAP LINE rides along for any substance whose target exists, so the tap is
//     never detached from a verdict there is one to detach from.
//
// ── The absence of a cap is not an empty cap ──────────────────────────────────
//
// `capProgress` is null for a substance nobody set a target for, and null renders
// NOTHING — no "no cap set", no dash, no placeholder. That is the opt-in boundary
// working structurally: `substanceCapStatus()` is the only producer of a status and
// `capProgressLine()` the only consumer, and the query layer calls the producer only
// where a target row exists. This component cannot render reduction framing for
// somebody who asked for none, because it was handed nothing to render. Do not add a
// flag re-answering that question (docs/internals/substances.md).
//
// `cap: 0` is the OTHER state and does render: an opted-in target of zero — Dry
// January, a quit target — is a target, and its line says so.
//
// ── One control, a second mounting context (#4424 ruling 3) ───────────────────
//
// The row IS `SubstanceUnitControl`, the domain's one row control, exactly as the
// Substance use page's card mounts it — same taps, same `substance-unit` one-tap
// ledger, same cap line, same failure channel. This list owns only the row chrome and
// the substance's name; there is no overlay copy of the write and no longer an overlay
// copy of the tap. Undo arrived with the shared control: the sheet used to offer a log
// and no undo, so a mis-tap had to be carried to another page to correct.
//
// ── The sheet stays open after a tap ──────────────────────────────────────────
//
// Like the food bar and the practice list, and for the same reason: substance logging
// has no single "saved" moment. An evening may be three uses, and a mis-tap is
// corrected on the page that owns undo. The tap revalidates behind the sheet, so
// "stay where you were" holds.
export default function QuickSubstanceList({
  substances,
}: {
  substances: QuickSubstanceRow[];
}) {
  return (
    <ul
      data-testid="quick-entry-substance-list"
      className="flex flex-col gap-2"
    >
      {substances.map((substance) => (
        <li
          key={substance.key}
          data-testid={`quick-entry-substance-${substance.key}`}
          className="rounded-lg border border-(--border) bg-surface px-3 py-2.5"
        >
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {substance.label}
          </span>
          <div className="mt-1.5">
            <SubstanceUnitControl
              substance={substance.key}
              capProgress={substance.capProgress}
              testIdPrefix="quick-entry-substance"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
