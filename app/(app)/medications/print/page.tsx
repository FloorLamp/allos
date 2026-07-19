import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { MEDICATIONS_HREF } from "@/lib/hrefs";
import PrintButton from "@/components/illness/PrintButton";
import MedicationListView from "@/components/medications/MedicationListView";
import { getCurrentMedicationList } from "../med-data";

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
        <Link
          href={MEDICATIONS_HREF}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
        >
          <IconArrowLeft className="h-4 w-4" />
          Back to medications
        </Link>
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
