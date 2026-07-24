import { requireScope } from "@/lib/scope";
import BackgroundSection from "../../BackgroundSection";
import FamilyHistorySection from "../../FamilyHistorySection";
import CarePlanSection from "../../CarePlanSection";
import HealthGoalsSection from "../../HealthGoalsSection";
import { SectionHeader } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Care › Overview (#1079): a single STACKED pane of four LIGHT
// sections — Background, Family history, Care plan, Health goals — each a short
// form/list. Providers (the #1055 directory) is heavy and stays a solo pane. The
// Emergency Card settings moved to the Passport (#1087), so Background is just
// Smoking + Risk factors and no longer carries the `#emergency-card` anchor.
export default async function RecordsCareOverviewPage() {
  // Multi-view (#1328): one scope resolution threaded to the multi-view sections
  // (Family history / Care plan / Health goals). Background stays acting-profile —
  // it's person-level context, not a flat record list. Single view is byte-identical.
  const scope = await requireScope();
  return (
    <div className="space-y-12">
      <section data-testid="records-background">
        <SectionHeader
          id="background"
          title="Background"
          subtitle="Smoking history and health risk factors — person-level context that tailors screening reminders."
        />
        <BackgroundSection profileId={scope.actingProfileId} />
      </section>

      <section data-testid="records-family-history">
        <SectionHeader
          id="family-history"
          title="Family history"
          subtitle="Conditions affecting your relatives — hereditary risk context, coded when imported from a health record. Add entries manually or import from uploaded records (CCD Family History section)."
        />
        <FamilyHistorySection scope={scope} />
      </section>

      <section data-testid="records-care-plan">
        <SectionHeader
          id="care-plan"
          title="Care plan"
          subtitle="Planned & ordered care from your health records (Plan of Treatment / Care Plan section) — upcoming procedures, visits, tests, and orders. Add them manually or import from uploaded records."
        />
        <CarePlanSection scope={scope} />
      </section>

      <section data-testid="records-health-goals">
        <SectionHeader
          id="health-goals"
          title="Health goals"
          subtitle="Clinical goals & targets from your health records (Goals section) — e.g. an A1c or blood-pressure target set by a provider. (Distinct from your personal fitness Goals.)"
        />
        <HealthGoalsSection scope={scope} />
      </section>
    </div>
  );
}
