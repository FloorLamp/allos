import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { MEDICATIONS_HREF } from "@/lib/hrefs";
import PrintButton from "@/components/illness/PrintButton";
import MedicationListView from "@/components/medications/MedicationListView";
import { getCurrentMedicationList } from "../med-data";
import BackLink from "@/components/BackLink";

export const dynamic = "force-dynamic";

// The printable current-medication list (#852 item 4): the single most-requested
// clinical artifact ("bring your medication list"). A formatter over the shared
// getCurrentMedicationList gather — the SAME rows the /share view renders, and the same
// dose-string projection the Emergency Card uses (one computation). Prints legibly from
// dark mode via the @media print block in globals.css.
export default async function MedicationPrintPage() {
  const { login, profile } = await requireSession();
  const rows = getCurrentMedicationList(profile.id);

  return (
    <div data-testid="medication-print">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <BackLink
          href={MEDICATIONS_HREF}
          label="Back to medications"
          className=""
        />
        <PrintButton label="Print list" />
      </div>
      <div className="card">
        <MedicationListView
          title="Current medications"
          personName={profile.name}
          generatedAt={new Date().toISOString()}
          rows={rows}
          formatPrefs={getDisplayFormatPrefs(login.id)}
        />
      </div>
    </div>
  );
}
