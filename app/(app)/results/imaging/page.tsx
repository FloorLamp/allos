import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import ImagingSection from "../ImagingSection";

export const dynamic = "force-dynamic";

// Results › Imaging (#1079): the radiology study list + add form. Numeric imaging
// measurements (DEXA T-scores, calcium score) still live on Biomarkers. Content
// component moved, not rewritten.
export default async function ResultsImagingPage() {
  const scope = await requireScope();
  return (
    <PageContainer
      width="flow"
      className="mx-auto"
      data-testid="results-imaging"
    >
      <ImagingSection scope={scope} />
    </PageContainer>
  );
}
