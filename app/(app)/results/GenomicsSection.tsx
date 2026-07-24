import { getGenomicVariantsForProfiles } from "@/lib/queries";
import { stampSubjects, type ProfileScope } from "@/lib/scope";
import GenomicVariantForm from "@/app/(app)/genomics/GenomicVariantForm";
import GenomicVariantList from "@/app/(app)/genomics/GenomicVariantList";
import { addGenomicVariant } from "@/app/(app)/genomics/actions";

// The former /genomics index page body (#1042 phase 5), now the #genomics section
// of /results. Genomic variants: the profile's structured genetic results — gene,
// variant, genotype/star-allele/zygosity, ACMG significance, and a result-type
// class (pharmacogenomic / hereditary-risk / carrier / diagnostic). Captured from
// an uploaded clinical genetics or PGx report (Invitae/Color/Myriad/pharmacy
// panel) via AI extraction, or added manually. Stored FACTUALLY — a genomic
// result never goes stale, never nags for retest, and carries no risk
// interpretation here.
// Multi-view (#1328): genomic_variants is a truly-flat, durable list (no dedup CTE, no
// per-profile derivation), so it reads the view-set with the SET-BASED
// getGenomicVariantsForProfiles (the registered cross-profile module). Subject chips +
// per-item write gates via the stamped rows; single view is byte-identical.
export default function GenomicsSection({ scope }: { scope: ProfileScope }) {
  const multi = scope.viewIds.length > 1;
  const variants = stampSubjects(
    scope,
    getGenomicVariantsForProfiles(scope.viewIds)
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <GenomicVariantList
          items={variants}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
      </div>

      <div className="min-w-0 space-y-4">
        <GenomicVariantForm action={addGenomicVariant} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Variant data is stored on this server and is never sent to any
          external service except when you upload a report for extraction.
        </p>
      </div>
    </div>
  );
}
