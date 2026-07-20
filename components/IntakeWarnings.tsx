import { FindingCard } from "@/components/FindingCard";
import {
  interactionTitle,
  SEVERITY_LABEL,
  type InteractionHit,
} from "@/lib/drug-interactions";
import {
  pgxTitle,
  pgxStatusLabel,
  PGX_SEVERITY_LABEL,
  type PgxHit,
} from "@/lib/pgx";
import { ototoxicTitle, type OtotoxicHit } from "@/lib/ototoxic";
import {
  drugAllergyMatchLabel,
  drugAllergyDetail,
  drugAllergyEvidence,
  type DrugAllergyHit,
} from "@/lib/drug-allergy";
import {
  coverageScopeLine,
  type SafetyCoverageModel,
} from "@/lib/safety-coverage";

// The CROSS-KIND intake warnings (#746): drug-/supplement-interaction hits (#144)
// and the pharmacogenomics cross-check (#710). A supplement–drug interaction spans
// both kinds, so these render IDENTICALLY on BOTH the Nutrition → Supplements tab
// and the Medications page, over the SAME getInteractionWarnings / getPgxWarnings
// gathers and the SAME dedupeKey — so a dismiss on either surface (or on Upcoming)
// silences every twin through the shared findings bus (#435). One shared component
// so the two surfaces can't drift ("one question, one computation"). Inputs are
// already filtered through the suppression bus by the caller.
export default function IntakeWarnings({
  interactionWarnings,
  pgxWarnings,
  ototoxicWarnings = [],
  allergyWarnings = [],
  coverage = null,
}: {
  interactionWarnings: InteractionHit[];
  pgxWarnings: PgxHit[];
  // Ototoxic-medication awareness (#717): an active ototoxic medication → a calm, cited
  // hearing-safety note. Optional so a caller that doesn't gather it renders nothing.
  ototoxicWarnings?: OtotoxicHit[];
  // Drug-allergy × med cross-check (#1029): an active medication meeting a recorded
  // non-resolved allergy (direct, same-class, or documented cross-reactive class).
  // Optional so a caller that doesn't gather it renders nothing.
  allergyWarnings?: DrugAllergyHit[];
  // Screening-coverage summary (#1032): when present, an EMPTY result renders a calm
  // "checked N of M, no flags" scope line instead of nothing — so "no interactions
  // found" is distinguishable from "your stack isn't in our curated set". Optional
  // so a caller that doesn't gather it keeps the legacy silent-empty behavior.
  coverage?: SafetyCoverageModel | null;
}) {
  const empty =
    interactionWarnings.length === 0 &&
    pgxWarnings.length === 0 &&
    ototoxicWarnings.length === 0 &&
    allergyWarnings.length === 0;
  const scopeLine = coverage ? coverageScopeLine(coverage, empty) : null;
  if (empty && !scopeLine) return null;
  return (
    <>
      {/* Drug-allergy × medication warnings (issue #1029): a recorded allergy met by
          an active med. Informational, never prescriptive — a clinician-reviewed,
          deliberately-continued med is the common case, so each card is dismissible
          through the shared bus (same dedupeKey as the Upcoming twin). */}
      {allergyWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="allergy-med-warnings">
          {allergyWarnings.map((hit) => (
            <FindingCard
              key={hit.dedupeKey}
              testid={`allergy-med-warning-${hit.dedupeKey}`}
              tone="rose"
              title={
                <>
                  <span className="uppercase">
                    {drugAllergyMatchLabel(hit)}
                  </span>{" "}
                  · {hit.medName} × {hit.substance}
                </>
              }
              detail={drugAllergyDetail(hit)}
              evidence={drugAllergyEvidence(hit)}
              dismissKey={hit.dedupeKey}
              dismissLabel={`Dismiss ${hit.medName} allergy note`}
            />
          ))}
        </div>
      )}

      {/* Drug-/supplement-interaction warnings (issue #144) */}
      {interactionWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="interaction-warnings">
          {interactionWarnings.map((hit) => (
            <FindingCard
              key={hit.dedupeKey}
              testid={`interaction-warning-${hit.dedupeKey}`}
              tone="rose"
              title={
                <>
                  <span className="uppercase">
                    {SEVERITY_LABEL[hit.severity]}
                  </span>{" "}
                  · {interactionTitle(hit)}
                </>
              }
              detail={hit.mechanism}
              evidence={`Informational, not medical advice — discuss with your prescriber or pharmacist. Source: ${hit.source}`}
              dismissKey={hit.dedupeKey}
              dismissLabel={`Dismiss ${interactionTitle(hit)} interaction`}
            />
          ))}
        </div>
      )}

      {/* Pharmacogenomics cross-check (issue #710): a stored PGx result affecting an
          active medication. CPIC's guidance direction is relayed AS INFORMATION with
          its citation; never prescriptive — the app never auto-changes a med. */}
      {pgxWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="pgx-warnings">
          {pgxWarnings.map((hit) => (
            <FindingCard
              key={hit.dedupeKey}
              testid={`pgx-warning-${hit.dedupeKey}`}
              tone="violet"
              title={
                <>
                  <span className="uppercase">
                    {PGX_SEVERITY_LABEL[hit.severity]}
                  </span>{" "}
                  · {pgxTitle(hit)}
                </>
              }
              detail={
                <>
                  {hit.gene} {pgxStatusLabel(hit)} on file. CPIC guidance:{" "}
                  {hit.guidance}
                </>
              }
              evidence={`Informational — discuss with your prescriber before any change; do not stop or switch a medication based on this alone. Source: ${hit.source}`}
              dismissKey={hit.dedupeKey}
              dismissLabel={`Dismiss ${pgxTitle(hit)} pharmacogenomic note`}
            />
          ))}
        </div>
      )}

      {/* Ototoxic-medication awareness (issue #717): an active medication that is a
          well-established ototoxic (hearing/balance-toxic) agent. The class note is
          relayed AS INFORMATION with its citation; never prescriptive — the app never
          tells you to change a medication, and the absence of a flag is not clearance. */}
      {ototoxicWarnings.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="ototoxic-warnings">
          {ototoxicWarnings.map((hit) => (
            <FindingCard
              key={hit.dedupeKey}
              testid={`ototoxic-warning-${hit.dedupeKey}`}
              tone="amber"
              title={ototoxicTitle(hit)}
              detail={hit.note}
              evidence={`Informational — a general note about the medication class, not advice to change anything; discuss any hearing or balance concern with your prescriber. Source: ${hit.citation}`}
              dismissKey={hit.dedupeKey}
              dismissLabel={`Dismiss ${ototoxicTitle(hit)} hearing-safety note`}
            />
          ))}
        </div>
      )}

      {/* Screening-coverage scope line (#1032): what was checked and how much of the
          stack the curated set covers. Calm and informational — the legibility fix,
          not a warning; the "no flags" phrasing never reads as clearance. */}
      {scopeLine && (
        <p
          className="mb-4 text-xs text-slate-500 dark:text-slate-400"
          data-testid="safety-scope-line"
        >
          {scopeLine}
        </p>
      )}
    </>
  );
}
