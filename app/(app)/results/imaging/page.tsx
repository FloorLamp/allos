import { requireScope } from "@/lib/scope";
import PageContainer from "@/components/PageContainer";
import PaneIntro from "@/components/PaneIntro";
import ImagingSection from "../ImagingSection";

export const dynamic = "force-dynamic";

// Results › Imaging (#1079): the radiology study list + add form. Numeric imaging
// measurements (DEXA T-scores, calcium score) still live under Clinical results. Content
// component moved, not rewritten.
export default async function ResultsImagingPage() {
  const scope = await requireScope();
  return (
    <PageContainer
      width="flow"
      className="mx-auto"
      data-testid="results-imaging"
    >
      <PaneIntro title="Imaging" testId="results-pane-intro">
        Radiology studies, their findings, and the radiation they added up to.
      </PaneIntro>
      <ImagingSection scope={scope} />
    </PageContainer>
  );
}
