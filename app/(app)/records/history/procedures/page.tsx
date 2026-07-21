import { requireSession } from "@/lib/auth";
import ProceduresSection from "../../ProceduresSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › History › Procedures (#1079). Content component moved, not rewritten.
export default async function RecordsProceduresPage() {
  const { profile } = await requireSession();
  return (
    <div data-testid="records-procedures">
      <SectionSubtitle>
        Your procedure &amp; surgical history — coded (CPT / SNOMED) when
        imported from a health record. Add them manually or import from uploaded
        records (CCD Procedures section).
      </SectionSubtitle>
      <ProceduresSection profileId={profile.id} />
    </div>
  );
}
