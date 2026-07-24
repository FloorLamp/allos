import { requireScope } from "@/lib/scope";
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
  // Multi-view (#1328): resolve the cross-profile scope once and thread it to both
  // stacked sections; each reads its own view-set list-first. Single view is byte-
  // identical to the former requireSession()/profile.id path.
  const scope = await requireScope();
  return (
    <div className="space-y-12">
      <section data-testid="records-conditions">
        <SectionHeader
          id="conditions"
          title="Conditions"
          subtitle="Your problem list — active conditions and diagnoses, coded (ICD-10 / SNOMED) when imported from a health record."
        />
        <ConditionsSection scope={scope} cond={one(searchParams.cond)} />
      </section>

      <section data-testid="records-allergies">
        <SectionHeader
          id="allergies"
          title="Allergies"
          subtitle="Documented allergies plus allergen-specific IgE sensitizations detected from your labs. A key emergency-card field."
        />
        <AllergiesSection scope={scope} />
      </section>
    </div>
  );
}
