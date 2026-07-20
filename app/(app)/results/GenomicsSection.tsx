import { getGenomicVariants } from "@/lib/queries";
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
export default function GenomicsSection({ profileId }: { profileId: number }) {
  const variants = getGenomicVariants(profileId);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <GenomicVariantList items={variants} />
      </div>

      <div className="min-w-0 space-y-4">
        <GenomicVariantForm action={addGenomicVariant} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Informational only, not medical advice or genetic counseling. Variant
          data is stored on this server and is never sent to any external
          service except when you upload a report for extraction.
        </p>
      </div>
    </div>
  );
}
