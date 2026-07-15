import { requireSession } from "@/lib/auth";
import { getGenomicVariants } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import GenomicVariantForm from "./GenomicVariantForm";
import GenomicVariantList from "./GenomicVariantList";
import { addGenomicVariant } from "./actions";

export const dynamic = "force-dynamic";

// Genomic variants: the profile's structured genetic results — gene, variant,
// genotype/star-allele/zygosity, ACMG significance, and a result-type class
// (pharmacogenomic / hereditary-risk / carrier / diagnostic). Captured from an
// uploaded clinical genetics or PGx report (Invitae/Color/Myriad/pharmacy panel)
// via AI extraction, or added manually. Stored FACTUALLY — a genomic result never
// goes stale, never nags for retest, and carries no risk interpretation here.
export default async function GenomicsPage() {
  const { profile } = await requireSession();
  const variants = getGenomicVariants(profile.id);

  return (
    <div>
      <PageHeader
        title="Genomic variants"
        subtitle="Structured genetic results captured from clinical genetics / pharmacogenomic reports. Add them manually or import an uploaded report. Raw consumer-genotype files (23andMe / Ancestry / VCF) aren't parsed."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <GenomicVariantList items={variants} />
        </div>

        <div className="min-w-0 space-y-4">
          <GenomicVariantForm action={addGenomicVariant} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice or genetic counseling.
            Variant data is stored on this server and is never sent to any
            external service except when you upload a report for extraction.
          </p>
        </div>
      </div>
    </div>
  );
}
