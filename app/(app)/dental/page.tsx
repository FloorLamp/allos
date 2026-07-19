import { requireSession } from "@/lib/auth";
import {
  getDentalProcedures,
  getDentalProcedureFollowUps,
} from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import DentalProcedureForm from "./DentalProcedureForm";
import DentalProcedureList from "./DentalProcedureList";
import { addDentalProcedure } from "./actions";

export const dynamic = "force-dynamic";

// Dental: the profile's structured dental records — tooth-anchored procedures
// (fillings/crowns/extractions with tooth + surface + CDT code) and exam findings
// ("watch #14, recheck in 6 months") that seed the follow-up loop — newest first.
// Captured from an uploaded dental exam/treatment record via AI extraction, or added
// manually. Periodontal MEASUREMENTS (pocket depth, bleeding-on-probing) are
// biomarkers and trend on the Biomarkers surface; dental X-rays are imaging studies.
export default async function DentalPage() {
  const { profile } = await requireSession();
  const records = getDentalProcedures(profile.id);
  const followUps = getDentalProcedureFollowUps(profile.id);

  return (
    <div>
      <PageHeader
        title="Dental"
        subtitle="Your dental procedures and exam findings, anchored to teeth. Add them manually or import a dental record. Periodontal measurements (pocket depth, bleeding) live in Biomarkers; dental X-rays live in Imaging."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <DentalProcedureList items={records} followUps={followUps} />
        </div>

        <div className="min-w-0 space-y-4">
          <DentalProcedureForm action={addDentalProcedure} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. This is a record of dental
            work and findings, not a clinical charting tool.
          </p>
        </div>
      </div>
    </div>
  );
}
