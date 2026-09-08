"use client";

import SubstanceUnitControl from "@/components/substances/SubstanceUnitControl";
import {
  QuickEntryRow,
  QuickEntryRowList,
} from "@/components/quick-entry/QuickEntryRowList";

export interface QuickSubstanceRow {
  key: string;
  label: string;
  /** Rendered beside the label by `SubstanceUnitControl`; see its own header. */
  logLabel: string;
  /** Null for a substance with no target. */
  capProgress: string | null;
}

// The quick-entry overlay's SUBSTANCE row (issue #3327).
//
// WHY THE ROW EXISTS AT ALL. `QUICK_LOG_DOMAIN_CENSUS` argued substance logging OUT of
// the sheet: substance use lives under its own page with the #998 cap verdict beside
// the tap, and a sheet row would detach the tap from the context that makes it honest.
// #3279 ruling 1 narrowed that to its real premise — it presumes a cap EXISTS — and
// this list answers both halves: the ROW is offered only to a profile that already has
// a substance ledger row (lib/quick-log.ts, plus the server re-gate in
// app/(app)/quick-entry-actions.ts for a deep link that skipped it), and the CAP LINE
// rides the control below for any substance whose target exists. The null case and why
// it renders nothing at all live with the control, which owns that line (#4424).
//
// THE ROW *IS* `SubstanceUnitControl`, the domain's one row control, exactly as the
// Substance use page's card mounts it. This list owns the row chrome and the name;
// there is no overlay copy of the write and none of the tap.
//
// THE SHEET STAYS OPEN AFTER A TAP, like the food bar and the practice list: substance
// logging has no single "saved" moment, an evening may be three uses, and the tap
// revalidates behind the sheet.
export default function QuickSubstanceList({
  substances,
  subjectProfileId,
}: {
  substances: QuickSubstanceRow[];
  // The quick-log sheet's chosen subject (#4932), when it is not the acting profile.
  subjectProfileId?: number;
}) {
  return (
    <QuickEntryRowList testId="quick-entry-substance-list">
      {substances.map((substance) => (
        <QuickEntryRow
          key={substance.key}
          testId={`quick-entry-substance-${substance.key}`}
          identity={substance.label}
          actions={
            <SubstanceUnitControl
              substance={substance.key}
              capProgress={substance.capProgress}
              testIdPrefix="quick-entry-substance"
              subjectProfileId={subjectProfileId}
            />
          }
        />
      ))}
    </QuickEntryRowList>
  );
}
