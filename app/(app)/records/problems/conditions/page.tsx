import { requireScope } from "@/lib/scope";
import ConditionsSection from "../../ConditionsSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

// Health record › Problems › Conditions (#1079, un-stacked by #1449). A SOLO pane:
// the pill sub-tab names it, so it carries only its descriptive line — the family's
// solo-pane shape (Visits, Procedures, Providers, Skin …), not the h1-scale in-page
// heading the old stacked pane needed. Conditions owns the `?cond=` filter here.
export default async function RecordsConditionsPage(props: {
  searchParams: Promise<{ cond?: string }>;
}) {
  const searchParams = await props.searchParams;
  // Multi-view (#1328): resolve the cross-profile scope once; the section reads its
  // own view-set list-first. Single view is byte-identical to requireSession().
  const scope = await requireScope();
  return (
    <PageContainer width="flow" data-testid="records-conditions">
      <SectionSubtitle title="Conditions">
        Review active and resolved conditions and diagnoses.
      </SectionSubtitle>
      <ConditionsSection scope={scope} cond={one(searchParams.cond)} />
    </PageContainer>
  );
}
