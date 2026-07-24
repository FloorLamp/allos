import { requireScope } from "@/lib/scope";
import ProceduresSection from "../../ProceduresSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › History › Procedures (#1079). Content component moved, not rewritten.
export default async function RecordsProceduresPage(props: {
  searchParams: Promise<{ new?: string | string[]; name?: string | string[] }>;
}) {
  const scope = await requireScope();
  // Deep-link add-form prefill (#1083, mirrors #662): a preventive procedure-screening
  // row/nudge lands here with `?new=1&name=<procedure>`. Seed the add form's name.
  const sp = await props.searchParams;
  const newParam = Array.isArray(sp.new) ? sp.new[0] : sp.new;
  const nameParam = Array.isArray(sp.name) ? sp.name[0] : sp.name;
  const prefillName =
    newParam === "1" && nameParam?.trim() ? nameParam.trim() : undefined;
  return (
    <div data-testid="records-procedures">
      <SectionSubtitle>
        Your procedure &amp; surgical history — coded (CPT / SNOMED) when
        imported from a health record. Add them manually or import from uploaded
        records (CCD Procedures section).
      </SectionSubtitle>
      <ProceduresSection scope={scope} prefillName={prefillName} />
    </div>
  );
}
