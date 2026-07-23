import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import { IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
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

export function IntakeSafetyScope({
  coverage,
  className = "",
}: {
  coverage: SafetyCoverageModel;
  className?: string;
}) {
  const scopeLine = coverageScopeLine(coverage, true);
  if (!scopeLine) return null;

  return (
    <details
      className={`group px-1 text-xs text-slate-500 dark:text-slate-400 ${className}`}
      data-testid="safety-scope-footer"
    >
      <summary
        className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded outline-none transition hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden dark:hover:text-slate-200"
        data-testid="safety-scope-summary"
      >
        <span>Curated safety screen · no flags found</span>
        <IconChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <p
        className="mt-1 max-w-prose leading-relaxed"
        data-testid="safety-scope-line"
      >
        {scopeLine}
      </p>
    </details>
  );
}

// One calm safety-notices card for the intake surface's relevant findings. Callers
// scope whole-stack results before rendering: cross-kind interactions appear on both
// related surfaces, while medication-only findings stay on Medications. The card owns
// the single warning icon; embedded finding rows do not repeat it.
export default function IntakeWarnings({
  interactionWarnings,
  pgxWarnings,
  ototoxicWarnings = [],
  allergyWarnings = [],
  coverage = null,
}: {
  interactionWarnings: InteractionHit[];
  pgxWarnings: PgxHit[];
  ototoxicWarnings?: OtotoxicHit[];
  allergyWarnings?: DrugAllergyHit[];
  coverage?: SafetyCoverageModel | null;
}) {
  const total =
    interactionWarnings.length +
    pgxWarnings.length +
    ototoxicWarnings.length +
    allergyWarnings.length;
  if (total === 0) return null;
  const scopeLine = coverage ? coverageScopeLine(coverage, false) : null;

  const major = interactionWarnings.filter(
    (hit) => hit.severity === "major"
  ).length;
  const summary = [
    allergyWarnings.length > 0
      ? `${allergyWarnings.length} allergy note${allergyWarnings.length === 1 ? "" : "s"}`
      : null,
    interactionWarnings.length > 0
      ? `${interactionWarnings.length} interaction${interactionWarnings.length === 1 ? "" : "s"}${major > 0 ? ` (${major} major)` : ""}`
      : null,
    pgxWarnings.length > 0
      ? `${pgxWarnings.length} pharmacogenomic note${pgxWarnings.length === 1 ? "" : "s"}`
      : null,
    ototoxicWarnings.length > 0
      ? `${ototoxicWarnings.length} hearing-safety note${ototoxicWarnings.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sectionClass = (divided: boolean) =>
    `${divided ? "mt-3 border-t border-black/5 pt-3 dark:border-white/5 " : ""}divide-y divide-black/5 dark:divide-white/5`;

  return (
    <details
      className="card group"
      data-testid="intake-warnings"
      open={total <= 2}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg outline-none transition hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden dark:hover:text-slate-200">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <IconAlertTriangle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span className="text-base font-semibold text-slate-800 dark:text-slate-100">
              Safety notices
            </span>
          </span>
          <span className="mt-0.5 block pl-6 text-sm text-slate-500 dark:text-slate-400">
            {summary}
          </span>
        </span>
        <IconChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180 dark:text-slate-400" />
      </summary>

      <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
        {allergyWarnings.length > 0 ? (
          <div
            className={sectionClass(false)}
            data-testid="allergy-med-warnings"
          >
            {allergyWarnings.map((hit) => (
              <FindingCard
                key={hit.dedupeKey}
                testid={`allergy-med-warning-${hit.dedupeKey}`}
                tone="rose"
                embedded
                icon={false}
                title={
                  <>
                    {drugAllergyMatchLabel(hit)} · {hit.medName} ×{" "}
                    {hit.substance}
                  </>
                }
                detail={drugAllergyDetail(hit)}
                evidence={drugAllergyEvidence(hit)}
                dismissKey={hit.dedupeKey}
                dismissLabel={`Dismiss ${hit.medName} allergy note`}
              />
            ))}
          </div>
        ) : null}

        {interactionWarnings.length > 0 ? (
          <div
            className={sectionClass(allergyWarnings.length > 0)}
            data-testid="interaction-warnings"
          >
            {interactionWarnings.map((hit) => (
              <FindingCard
                key={hit.dedupeKey}
                testid={`interaction-warning-${hit.dedupeKey}`}
                tone="rose"
                embedded
                icon={false}
                title={
                  <>
                    {SEVERITY_LABEL[hit.severity]} · {interactionTitle(hit)}
                  </>
                }
                detail={hit.mechanism}
                evidence={`${MEDICAL_DISCLAIMER} Discuss with your prescriber or pharmacist. Source: ${hit.source}`}
                dismissKey={hit.dedupeKey}
                dismissLabel={`Dismiss ${interactionTitle(hit)} interaction`}
              />
            ))}
          </div>
        ) : null}

        {pgxWarnings.length > 0 ? (
          <div
            className={sectionClass(
              allergyWarnings.length > 0 || interactionWarnings.length > 0
            )}
            data-testid="pgx-warnings"
          >
            {pgxWarnings.map((hit) => (
              <FindingCard
                key={hit.dedupeKey}
                testid={`pgx-warning-${hit.dedupeKey}`}
                tone="violet"
                embedded
                icon={false}
                title={
                  <>
                    {PGX_SEVERITY_LABEL[hit.severity]} · {pgxTitle(hit)}
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
        ) : null}

        {ototoxicWarnings.length > 0 ? (
          <div
            className={sectionClass(
              allergyWarnings.length > 0 ||
                interactionWarnings.length > 0 ||
                pgxWarnings.length > 0
            )}
            data-testid="ototoxic-warnings"
          >
            {ototoxicWarnings.map((hit) => (
              <FindingCard
                key={hit.dedupeKey}
                testid={`ototoxic-warning-${hit.dedupeKey}`}
                tone="amber"
                embedded
                icon={false}
                title={ototoxicTitle(hit)}
                detail={hit.note}
                evidence={`${MEDICAL_DISCLAIMER} A general note about the medication class, not a recommendation to change anything; discuss any hearing or balance concern with your prescriber. Source: ${hit.citation}`}
                dismissKey={hit.dedupeKey}
                dismissLabel={`Dismiss ${ototoxicTitle(hit)} hearing-safety note`}
              />
            ))}
          </div>
        ) : null}

        {scopeLine ? (
          <p
            className={`${total > 0 ? "mt-3 border-t border-black/5 pt-3 dark:border-white/5" : ""} text-xs text-slate-500 dark:text-slate-400`}
            data-testid="safety-scope-line"
          >
            {scopeLine}
          </p>
        ) : null}
      </div>
    </details>
  );
}
