import { requireScope } from "@/lib/scope";
import BackgroundSection from "../../BackgroundSection";
import FamilyHistorySection from "../../FamilyHistorySection";
import CarePlanSection from "../../CarePlanSection";
import HealthGoalsSection from "../../HealthGoalsSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";
import CareOverviewDisclosure from "./CareOverviewDisclosure";

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
    <PageContainer width="flow" className="space-y-5">
      <SectionSubtitle title="Care overview">
        Keep the personal context, family history, plans, and clinical goals
        that shape your care.
      </SectionSubtitle>

      <CareOverviewDisclosure
        id="background"
        title="Background"
        description="Smoking history and health risk factors"
        hashAliases={["smoking-history", "risk-factors"]}
        testId="records-background"
      >
        <BackgroundSection profileId={scope.actingProfileId} />
      </CareOverviewDisclosure>

      <CareOverviewDisclosure
        id="family-history"
        title="Family history"
        description="Conditions affecting relatives"
        testId="records-family-history"
      >
        <FamilyHistorySection scope={scope} />
      </CareOverviewDisclosure>

      <CareOverviewDisclosure
        id="care-plan"
        title="Care plan"
        description="Planned and ordered care"
        testId="records-care-plan"
      >
        <CarePlanSection scope={scope} />
      </CareOverviewDisclosure>

      <CareOverviewDisclosure
        id="health-goals"
        title="Health goals"
        description="Clinical goals and targets"
        testId="records-health-goals"
      >
        <HealthGoalsSection scope={scope} />
      </CareOverviewDisclosure>
    </PageContainer>
  );
}
