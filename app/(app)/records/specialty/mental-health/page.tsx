import { redirect } from "next/navigation";
import { requireScope } from "@/lib/scope";
import { isMentalHealthScreeningRelevant } from "@/lib/life-stage";
import { getProfileAge } from "@/lib/settings";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import { isInstrument, type Instrument } from "@/lib/mental-health";
import MentalHealthSection from "../../MentalHealthSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Mental health (#1079). The #716 crisis line is CONTENT and
// travels with this route (the safety contract is content, not route).
//
// LIFE-STAGE GATED since #2807, on exactly the argument #1174 made for substance use one
// pane over: the instruments this page administers are validated for a population, and
// PHQ-9/GAD-7's is adolescents and adults (PHQ-A is the adolescent form; nothing here is
// a pediatric instrument). A 22-month-old profile was being offered PHQ-9 entry, because
// "always renders" plus a nav that carried no bit for this pane at all meant the only
// protection was not knowing the URL. The line is LOWER than substance use's — an
// adolescent keeps this pane and loses that one — and it hides on a positive infant/child
// match only, never on unknown age.
//
// Like the substance-use gate this is not folded over the view set (#2557): the content
// belongs to ONE data subject, so the age that governs it is the ACTING profile's. Only
// the redirect TARGET is view-aware, so a bounced visitor lands on a pane the sub-tab
// strip is actually showing them.
export default async function RecordsMentalHealthPage(props: {
  searchParams: Promise<{ screen?: string | string[] }>;
}) {
  const scope = await requireScope();
  const profileId = scope.actingProfileId;
  // The first VISIBLE pane, from the shared gated list (see the substance-use pane).
  if (!isMentalHealthScreeningRelevant(getProfileAge(profileId)))
    redirect(
      visibleSpecialtyPanes(
        getRecordsSpecialtyRelevanceForView(profileId, scope.viewIds)
      )[0].href
    );
  // Deep-link preselect (#1083): a preventive depression/anxiety-screening row/nudge
  // lands here with `?screen=<INSTRUMENT>`. Validate; unknown/absent ⇒ PHQ-9 default.
  const rawScreen = (await props.searchParams).screen;
  const screenParam = Array.isArray(rawScreen) ? rawScreen[0] : rawScreen;
  const initialInstrument: Instrument | undefined = isInstrument(screenParam)
    ? screenParam
    : undefined;
  return (
    <PageContainer width="reading" data-testid="records-mental-health">
      <SectionSubtitle title="Mental health">
        Track validated screening instruments — PHQ-9 and GAD-7 — as
        severity-banded scores over time.
      </SectionSubtitle>
      <MentalHealthSection
        profileId={profileId}
        isAdmin={scope.role === "admin"}
        initialInstrument={initialInstrument}
      />
    </PageContainer>
  );
}
