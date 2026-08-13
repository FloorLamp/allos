import { redirect } from "next/navigation";
import { requireScope } from "@/lib/scope";
import { isMinor } from "@/lib/life-stage";
import { getProfileAge, getDisplayFormatPrefs } from "@/lib/settings";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import { isSubstanceInstrument } from "@/lib/substance-use";
import SubstanceUseSection from "../../SubstanceUseSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Substance use (#1175, formerly /medical/substance-use
// #998). LIFE-STAGE GATED (#1174): its instruments are adult-validated (USPSTF
// alcohol/drug screening is 18+; adolescents use CRAFFT, not AUDIT/DAST), so the
// sub-tab hides for a KNOWN minor AND this route re-gates server-side — a direct hit
// from a minor redirects to the first always-visible specialty pane (the same
// SettingsTabs discipline Vision/Dental use: a hidden tab is an unreachable route).
// The gate uses isMinor (adult OR unknown age → shown; hide only on a positive
// under-age match, never on missing data) — the section-visibility predicate lives in
// getRecordsSpecialtyRelevance / records/nav.ts, so the sub-tab and this route agree.
// Mental health, adolescent-validated, is deliberately NOT gated this way.
//
// This section is NOT multi-view and its gate is not folded over the view set (#2557):
// the content it serves belongs to ONE data subject, so the age that governs it is the
// ACTING profile's. Only the redirect TARGET is view-aware, so a bounced visitor lands
// on a pane the sub-tab strip is actually showing them.
export default async function RecordsSubstanceUsePage(props: {
  searchParams: Promise<{ screen?: string | string[] }>;
}) {
  const scope = await requireScope();
  const profileId = scope.actingProfileId;
  // The first VISIBLE pane, from the shared gated list (see the Vision pane's note).
  if (isMinor(getProfileAge(profileId)))
    redirect(
      visibleSpecialtyPanes(
        getRecordsSpecialtyRelevanceForView(profileId, scope.viewIds)
      )[0].href
    );
  // Deep-link preselect (#1083): a preventive drug/alcohol-screening row/nudge lands
  // here with `?screen=<INSTRUMENT>`. Validate against the known instruments; an
  // unknown/absent value falls through to the form's AUDIT-C default.
  const rawScreen = (await props.searchParams).screen;
  const screenParam = Array.isArray(rawScreen) ? rawScreen[0] : rawScreen;
  const initialInstrument = isSubstanceInstrument(screenParam)
    ? screenParam
    : undefined;
  return (
    <PageContainer width="reading" data-testid="records-substance-use">
      <SectionSubtitle title="Substance use">
        Track validated screening scores (AUDIT-C, AUDIT, DAST-10), alcohol,
        nicotine, and cannabis use over time, and reduction targets you set
        yourself.
      </SectionSubtitle>
      <SubstanceUseSection
        profileId={profileId}
        formatPrefs={getDisplayFormatPrefs(scope.loginId)}
        initialInstrument={initialInstrument}
      />
    </PageContainer>
  );
}
