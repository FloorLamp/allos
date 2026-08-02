import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import GenomicsSection from "../GenomicsSection";

export const dynamic = "force-dynamic";

// Results › Genomics (#1079): structured genetic results from clinical genetics /
// pharmacogenomic reports. Raw consumer-genotype files (23andMe / Ancestry / VCF)
// aren't parsed. Content component moved, not rewritten.
export default async function ResultsGenomicsPage() {
  const scope = await requireScope();
  return (
    <PageContainer
      width="flow"
      className="mx-auto"
      data-testid="results-genomics"
    >
      <GenomicsSection scope={scope} />
    </PageContainer>
  );
}
