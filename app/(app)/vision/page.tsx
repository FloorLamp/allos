import { requireSession } from "@/lib/auth";
import { getOpticalPrescriptions } from "@/lib/queries";
import { today } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import OpticalPrescriptionForm from "./OpticalPrescriptionForm";
import OpticalPrescriptionList from "./OpticalPrescriptionList";
import OpticalProgression from "./OpticalProgression";
import { addOpticalPrescription } from "./actions";

export const dynamic = "force-dynamic";

// Vision / eye care: the profile's structured optical (eyeglass/contact)
// prescriptions — per-eye sphere/cylinder/axis/add, PD, and the contacts extras —
// newest issued first, with a per-eye sphere-over-time progression (the "is my
// myopia getting worse?" view). Captured from an uploaded Rx slip / eye-exam report
// via AI extraction (Data → Import), or added manually. Rx expiry surfaces as plain
// "expires soon" / "expired" text; the recurring eye-exam reminder lives on the
// existing vision_exam preventive rule, not duplicated here (#697).
export default async function VisionPage() {
  const { profile } = await requireSession();
  const prescriptions = getOpticalPrescriptions(profile.id);

  return (
    <div>
      <PageHeader
        title="Vision"
        subtitle="Your eyeglass and contact-lens prescriptions — per-eye power, PD, and how your sphere has changed over time. Add them manually or import an uploaded Rx slip."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <OpticalProgression items={prescriptions} />
          <OpticalPrescriptionList
            items={prescriptions}
            today={today(profile.id)}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <OpticalPrescriptionForm action={addOpticalPrescription} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. OD = right eye, OS = left
            eye.
          </p>
        </div>
      </div>
    </div>
  );
}
