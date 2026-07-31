import { requireScope } from "@/lib/scope";
import AllergiesSection from "../../AllergiesSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Problems › Allergies (#1079, un-stacked by #1449). A SOLO pane —
// the pill sub-tab names it, so it carries only its descriptive line. Splitting it
// off Conditions also gives allergy deep links (search, timeline, import review) a
// target that lands ON the list instead of above it.
export default async function RecordsAllergiesPage() {
  const scope = await requireScope();
  return (
    <section data-testid="records-allergies">
      <SectionSubtitle>
        Documented allergies plus allergen-specific IgE sensitizations detected
        from your labs. A key emergency-card field.
      </SectionSubtitle>
      <AllergiesSection scope={scope} />
    </section>
  );
}
