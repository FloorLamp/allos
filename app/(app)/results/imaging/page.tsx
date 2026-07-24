import { requireScope } from "@/lib/scope";
import ImagingSection from "../ImagingSection";

export const dynamic = "force-dynamic";

// Results › Imaging (#1079): the radiology study list + add form. Numeric imaging
// measurements (DEXA T-scores, calcium score) still live on Biomarkers. Content
// component moved, not rewritten.
export default async function ResultsImagingPage() {
  const scope = await requireScope();
  return (
    <div data-testid="results-imaging">
      <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
        Your radiology studies — modality, region, laterality, contrast, and the
        radiologist&apos;s impression. Add them manually or import an uploaded
        report. Numeric imaging measurements (DEXA T-scores, calcium score)
        still live in Biomarkers.
      </p>
      <ImagingSection scope={scope} />
    </div>
  );
}
