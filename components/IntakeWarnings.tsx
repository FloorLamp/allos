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
}: {
  interactionWarnings: InteractionHit[];
  pgxWarnings: PgxHit[];
}) {
  if (interactionWarnings.length === 0 && pgxWarnings.length === 0) return null;
  return (
    <>
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
    </>
  );
}
