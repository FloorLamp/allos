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
      <SectionSubtitle more="Allergen-specific IgE sensitizations detected in lab results appear alongside documented allergies and can inform the emergency card.">
        Review documented allergies and sensitizations.
      </SectionSubtitle>
      <AllergiesSection scope={scope} />
    </section>
  );
}
