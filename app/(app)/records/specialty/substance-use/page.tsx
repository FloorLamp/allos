import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { isMinor } from "@/lib/life-stage";
import { getUserAge } from "@/lib/settings";
import { isSubstanceInstrument } from "@/lib/substance-use";
import SubstanceUseSection from "../../SubstanceUseSection";
import { SectionSubtitle } from "../../SectionHeader";

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
export default async function RecordsSubstanceUsePage(props: {
  searchParams: Promise<{ screen?: string | string[] }>;
}) {
  const { profile } = await requireSession();
  if (isMinor(getUserAge(profile.id))) redirect("/records/specialty/skin");
  // Deep-link preselect (#1083): a preventive drug/alcohol-screening row/nudge lands
  // here with `?screen=<INSTRUMENT>`. Validate against the known instruments; an
  // unknown/absent value falls through to the form's AUDIT-C default.
  const rawScreen = (await props.searchParams).screen;
  const screenParam = Array.isArray(rawScreen) ? rawScreen[0] : rawScreen;
  const initialInstrument = isSubstanceInstrument(screenParam)
    ? screenParam
    : undefined;
  return (
    <div data-testid="records-substance-use">
      <SectionSubtitle>
        Track validated screening scores (AUDIT-C, AUDIT, DAST-10), alcohol,
        nicotine, and cannabis use over time, and reduction targets you set
        yourself. A screening tool, not a diagnosis. Informational, not medical
        advice.
      </SectionSubtitle>
      <SubstanceUseSection
        profileId={profile.id}
        initialInstrument={initialInstrument}
      />
    </div>
  );
}
