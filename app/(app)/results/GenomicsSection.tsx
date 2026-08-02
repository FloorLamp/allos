import {
  getGenomicVariantsForProfiles,
  getPgxMedCrossLinks,
} from "@/lib/queries";
import { stampSubjects, type ProfileScope } from "@/lib/scope";
import GenomicVariantForm from "@/app/(app)/results/genomics/GenomicVariantForm";
import GenomicVariantList from "@/app/(app)/results/genomics/GenomicVariantList";
import { addGenomicVariant } from "@/app/(app)/results/genomics/actions";
import AddEntryPanel from "@/components/AddEntryPanel";

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
  // Bidirectional safety cross-link (#1354): variantId → the active meds this PGx
  // variant affects, the SAME pharmacogenomic findings the /medications safety strip
  // shows, through the SAME dismissal bus. Variant ids are globally unique, so merging
  // the per-profile maps across the view-set is collision-free.
  const affectedMeds = Object.fromEntries(
    scope.viewIds.flatMap((pid) => Object.entries(getPgxMedCrossLinks(pid)))
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddEntryPanel
          testId="add-genomic-panel"
          panelId="add-genomic-panel-body"
          label="Add genomic variant"
          presentation="modal"
        >
          <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
            Enter a clinical genetics or pharmacogenomic result. Raw consumer
            genotype files aren&apos;t supported.
          </p>
          <GenomicVariantForm action={addGenomicVariant} />
        </AddEntryPanel>
      </div>
      <GenomicVariantList
        items={variants}
        affectedMeds={affectedMeds}
        multiView={
          multi ? { actingProfileId: scope.actingProfileId } : undefined
        }
      />
    </div>
  );
}
