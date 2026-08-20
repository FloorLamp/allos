import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import type { AppRoute } from "@/lib/hrefs";
import PrintButton from "@/components/illness/PrintButton";
import ImmunizationRecordView from "@/components/immunizations/ImmunizationRecordView";
import { getImmunizationRecord } from "../record-data";
import BackLink from "@/components/BackLink";

export const dynamic = "force-dynamic";

// The printable immunization record (#1849): the one record type whose stated
// purpose is handing a paper copy to a registrar finally has a print view, on the
// /medications/print pattern — a formatter over the shared getImmunizationRecord
// gather, rendering the SAME view component the tokenized /share link serves (one
// computation). Prints legibly from dark mode via the @media print block in
// globals.css.
const IMMUNIZATIONS_HREF = "/records/history/immunizations" as AppRoute;

export default async function ImmunizationPrintPage() {
  const { login, profile } = await requireSession();
  const record = getImmunizationRecord(profile.id, profile.name);

  return (
    <div data-testid="immunization-print">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <BackLink
          href={IMMUNIZATIONS_HREF}
          label="Back to immunizations"
          className=""
        />
        <PrintButton label="Print record" />
      </div>
      <div className="card">
        <ImmunizationRecordView
          personName={record.personName}
          birthdate={record.birthdate}
          generatedAt={new Date().toISOString()}
          groups={record.groups}
          formatPrefs={getDisplayFormatPrefs(login.id)}
        />
      </div>
    </div>
  );
}
