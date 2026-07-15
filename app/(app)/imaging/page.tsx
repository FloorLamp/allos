import { requireSession } from "@/lib/auth";
import { getImagingStudies } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import ImagingStudyForm from "./ImagingStudyForm";
import ImagingStudyList from "./ImagingStudyList";
import { addImagingStudy } from "./actions";

export const dynamic = "force-dynamic";

// Imaging studies: the profile's structured radiology studies — modality, body
// region, laterality, contrast, and the radiologist's impression — newest first,
// filterable by modality / region. Captured from an uploaded radiology report via
// AI extraction, or added manually. This is the NARRATIVE + METADATA home for
// imaging; numeric imaging metrics (DEXA T-scores, calcium score, EF, IMT) still
// live as `scan` biomarkers and trend there. Image pixels / DICOM are out of scope —
// Allos holds the report, not the images.
export default async function ImagingPage() {
  const { profile } = await requireSession();
  const studies = getImagingStudies(profile.id);

  return (
    <div>
      <PageHeader
        title="Imaging"
        subtitle="Your radiology studies — modality, region, laterality, contrast, and the radiologist's impression. Add them manually or import an uploaded report. Numeric imaging measurements (DEXA T-scores, calcium score) still live in Biomarkers."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <ImagingStudyList items={studies} />
        </div>

        <div className="min-w-0 space-y-4">
          <ImagingStudyForm action={addImagingStudy} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. Allos stores the imaging
            report, not the images themselves (DICOM is out of scope).
          </p>
        </div>
      </div>
    </div>
  );
}
