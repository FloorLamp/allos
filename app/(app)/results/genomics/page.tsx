import { requireScope } from "@/lib/scope";
import GenomicsSection from "../GenomicsSection";

export const dynamic = "force-dynamic";

// Results › Genomics (#1079): structured genetic results from clinical genetics /
// pharmacogenomic reports. Raw consumer-genotype files (23andMe / Ancestry / VCF)
// aren't parsed. Content component moved, not rewritten.
export default async function ResultsGenomicsPage() {
  const scope = await requireScope();
  return (
    <div data-testid="results-genomics">
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Structured genetic results captured from clinical genetics /
        pharmacogenomic reports. Add them manually or import an uploaded report.
        Raw consumer-genotype files (23andMe / Ancestry / VCF) aren&apos;t
        parsed.
      </p>
      <GenomicsSection scope={scope} />
    </div>
  );
}
