import {
  diagnosisList,
  groupDiagnosisChips,
  type DiagnosisChipGroup,
} from "@/lib/diagnosis-chips";
import {
  decodeDiagnosisRanks,
  diagnosisRankBadge,
  rankForDiagnosis,
  spokenDiagnosisList,
  type VisitDiagnosisRank,
} from "@/lib/visit-diagnosis-rank";

// The visit-diagnosis chips, shared by the visit list and the visit detail page
// (#2589). Two DIFFERENT kinds of statement render here, and keeping them
// distinguishable is the job:
//
//  - COMPACTION is presentation, and it is ours. Consecutive names sharing a long
//    stem print the stem once and each name's tail after it, because one long
//    Z-code diagnosis listed twice with a suffix costs four wrapped lines on a
//    phone card. `stem + tail` is the original name exactly, so nothing is
//    dropped; the grouping rule knows nothing about what the shared text MEANS
//    (see lib/diagnosis-chips.ts — long etiology pairs group too), which is
//    tolerable only because it never claims the names are one diagnosis.
//  - The RANK badge is data, and it is the SOURCE's. It renders only what an
//    import source stated structurally (FHIR Encounter.diagnosis.rank / .use),
//    never anything read out of a name.
//
// So the two are styled apart on purpose: a filled uppercase pill is a source
// claim, a hairline-ruled italic fragment is part of a name. And both reach the
// accessibility tree — the factored pieces are aria-hidden behind full names that
// CARRY their rank (`spokenDiagnosisList`), because a badge visible only to
// sighted users would be half 2 deleting half 1.
//
// WHAT IS AND IS NOT GUARDED — stated plainly, because an earlier draft of this
// header undersold it and the draft after that went stale the moment the gap
// closed. Every DECISION this file makes is pure and tested elsewhere: the
// grouping (lib/diagnosis-chips.ts), the badge vocabulary and the spoken strings
// (lib/visit-diagnosis-rank.ts). Whether this file still CALLS any of it is the
// other half of docs/internals/component-tests.md's contract, and it is now held
// by e2e/encounters.spec.ts ("source-stated diagnosis ranks (#2589)"), which
// plants its own encounter carrying `diagnosis_ranks` and asserts the rendered
// strings on both branches. Each of the mutations that used to pass the whole
// suite byte-identical was re-run against it and now FAILS:
//
//  - deleting <RankBadge/> from the single-chip branch, which is the DOMINANT
//    path (grouping needs a 40-character shared stem) — guarded by the badge's
//    count and exact text on the ungrouped chip;
//  - dropping `aria-hidden` from the stem or tail spans, so a screen reader hears
//    the fragments AND the full names — guarded per span;
//  - passing `m.tail` instead of `m.name` into `spokenDiagnosisList`, so it speaks
//    fragments — guarded by the sr-only text, asserted in full;
//  - dropping `title=` from the grouped chip, so hover recovers nothing — guarded
//    by the exact title string;
//  - deleting <RankBadge/> from a tail, which the spec adds on top of the four
//    above: the two members carry DIFFERENT source claims, so each tail's badge is
//    asserted by its own text.
//
// What is still unguarded here is presentation the DOM cannot state: which of the
// two shapes is a filled pill and which a hairline-ruled italic fragment. That
// distinction is load-bearing (half 1 exists because "a rank" and "a word in a
// name" are different kinds of statement) and lives only in the class strings
// below — change them with that in mind.
//
// Server-renderable: no state, no client hooks, so both surfaces use one copy.

// The rank badge is a claim the SOURCE made. It is deliberately not styled like
// anything this file invents: solid fill, uppercase, its own tooltip. A factored
// tail below is a fragment of a NAME, and the two must not be mistakable for each
// other — half 1 exists precisely because "a rank" and "a word in a name" are
// different kinds of statement.
function RankBadge({ entry }: { entry: VisitDiagnosisRank | null }) {
  const label = entry ? diagnosisRankBadge(entry) : null;
  if (!label) return null;
  return (
    <span
      className="ml-1 rounded-full bg-amber-700 px-1.5 text-xs font-semibold uppercase tracking-wide text-amber-50 dark:bg-amber-300 dark:text-amber-950"
      data-testid="diagnosis-rank-badge"
      // Not "Rank stated by…": the badge also carries role labels on their own
      // when the rank was withheld, and naming only the rank would mis-describe
      // half of what it shows.
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
  // The factored form. The visual parts are aria-hidden and the full names — with
  // their ranks, composed by the pure `spokenDiagnosisList` — are spoken instead,
  // so nothing about this layout reaches assistive technology as an abbreviation.
  // The title carries the same strings for hover.
  const spoken = spokenDiagnosisList(
    group.members.map((m) => m.name),
    ranks
  );
  return (
    <span
      className={`${CHIP} flex-wrap gap-x-1 gap-y-0.5`}
      data-testid="diagnosis-chip-group"
      title={spoken.join("\n")}
    >
      <span className="sr-only">{spoken.join("; ")}</span>
      <span aria-hidden="true">{group.stem}</span>
      {group.members.map((m, i) => (
        <span
          key={i}
          aria-hidden="true"
          // A continuation of the name, marked as one: a hairline rule and italics,
          // NOT a filled pill. The filled pill is the rank badge, and only the
          // source gets to make that claim (see RankBadge).
          className="inline-flex items-center border-l border-amber-500/50 pl-1.5 italic dark:border-amber-400/40"
          data-testid="diagnosis-chip-tail"
        >
          {/* The tail is printed RAW — `stem + tail` is the original name, and
              this component drops none of it (a leading space is collapsed by
              the browser at the start of the flex item, not by us). An entry
              that IS the stem has no tail of its own; the dash says "this one,
              and nothing further" rather than rendering an empty pill. */}
          {m.tail.trim() ? m.tail : "—"}
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
