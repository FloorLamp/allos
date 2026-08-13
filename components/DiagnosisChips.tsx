import {
  diagnosisList,
  groupDiagnosisChips,
  type DiagnosisChipGroup,
} from "@/lib/diagnosis-chips";
import {
  decodeDiagnosisRanks,
  diagnosisRankBadge,
  rankForDiagnosis,
  type VisitDiagnosisRank,
} from "@/lib/visit-diagnosis-rank";

// The visit-diagnosis chips, shared by the visit list and the visit detail page
// (#2589). Two things happen here and they are deliberately separate:
//
//  - COMPACTION is presentation only. Consecutive names sharing a long stem
//    print the stem once and each name's tail after it, because one long Z-code
//    diagnosis listed twice with a suffix costs four wrapped lines on a phone
//    card. Nothing is hidden: every character of every name is on screen, the
//    untouched names are the group's accessible text and its hover title, and
//    the worst case if the grouping is odd is a chip that looks odd.
//  - The RANK badge is data. It renders only what an import source stated
//    structurally (FHIR Encounter.diagnosis.rank / .use) and never anything read
//    out of the name itself.
//
// Server-renderable: no state, no client hooks, so both surfaces use one copy.

function RankBadge({ entry }: { entry: VisitDiagnosisRank | null }) {
  const label = entry ? diagnosisRankBadge(entry) : null;
  if (!label) return null;
  return (
    <span
      className="ml-1 rounded-full bg-amber-200/80 px-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      data-testid="diagnosis-rank-badge"
      title="Stated by the source record"
    >
      {label}
    </span>
  );
}

const CHIP =
  "badge max-w-full bg-amber-100 text-amber-700 wrap-break-word dark:bg-amber-950 dark:text-amber-300";

function Chip({
  group,
  ranks,
}: {
  group: DiagnosisChipGroup;
  ranks: VisitDiagnosisRank[];
}) {
  if (group.kind === "single") {
    return (
      <span className={CHIP} data-testid="diagnosis-chip">
        {group.name}
        <RankBadge entry={rankForDiagnosis(ranks, group.name)} />
      </span>
    );
  }
  // The factored form. The visual parts are aria-hidden and the full names are
  // spoken verbatim, so nothing about this layout reaches assistive technology
  // as an abbreviation — the same reason the title carries them too.
  return (
    <span
      className={`${CHIP} flex-wrap gap-x-1 gap-y-0.5`}
      data-testid="diagnosis-chip-group"
      title={group.members.map((m) => m.name).join("\n")}
    >
      <span className="sr-only">
        {group.members.map((m) => m.name).join("; ")}
      </span>
      <span aria-hidden="true">{group.stem}</span>
      {group.members.map((m, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="inline-flex items-center rounded-full bg-amber-200/70 px-1.5 dark:bg-amber-900/70"
          data-testid="diagnosis-chip-tail"
        >
          {/* An entry that IS the stem has no tail of its own; the dash says
              "this one, and nothing further" rather than dropping it. */}
          {m.tail || "—"}
          <RankBadge entry={rankForDiagnosis(ranks, m.name)} />
        </span>
      ))}
    </span>
  );
}

export default function DiagnosisChips({
  diagnoses,
  diagnosisRanks,
  testId,
}: {
  diagnoses: string | null | undefined;
  diagnosisRanks?: string | null;
  testId?: string;
}) {
  const names = diagnosisList(diagnoses);
  if (names.length === 0) return null;
  const ranks = decodeDiagnosisRanks(diagnosisRanks);
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" data-testid={testId}>
      {groupDiagnosisChips(names).map((group, i) => (
        <Chip key={i} group={group} ranks={ranks} />
      ))}
    </div>
  );
}
