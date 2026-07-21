import { requireSession } from "@/lib/auth";
import ConditionsSection from "../ConditionsSection";
import AllergiesSection from "../AllergiesSection";
import { SectionHeader } from "../SectionHeader";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

// Health record › Problems (#1079): a single STACKED pane — Conditions + Allergies,
// both short lists that share the problem-list mental model, so the group tab shows
// them directly with no secondary strip. Each keeps its existing header + anchor so
// an old `#conditions`/`#allergies` deep link still resolves within the pane.
// Conditions owns the `?cond=` filter on this route now.
export default async function RecordsProblemsPage(props: {
  searchParams: Promise<{ cond?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  return (
    <div className="space-y-12">
      <section data-testid="records-conditions">
        <SectionHeader
          id="conditions"
          title="Conditions"
          subtitle="Your problem list — active conditions and diagnoses, coded (ICD-10 / SNOMED) when imported from a health record."
        />
        <ConditionsSection
          profileId={profile.id}
          cond={one(searchParams.cond)}
        />
      </section>

      <section data-testid="records-allergies">
        <SectionHeader
          id="allergies"
          title="Allergies"
          subtitle="Documented allergies plus allergen-specific IgE sensitizations detected from your labs. A key emergency-card field."
        />
        <AllergiesSection profileId={profile.id} />
      </section>
    </div>
  );
}
