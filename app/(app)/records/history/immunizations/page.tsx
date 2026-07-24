import { requireScope } from "@/lib/scope";
import ImmunizationsSection from "../../ImmunizationsSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

// Health record › History › Immunizations (#1079): the vaccination record + its
// schedule chart. A heavy solo pane (the chart) — never stacked. Owns its
// `?sort/?dir/?status` table state on this route now that the collision-avoidance
// namespacing is gone. Content component moved, not rewritten.
export default async function RecordsImmunizationsPage(props: {
  searchParams: Promise<{ sort?: string; dir?: string; status?: string }>;
}) {
  const searchParams = await props.searchParams;
  // Multi-view (#1359): resolve the cross-profile scope once — the flat recorded-doses
  // list reads its own view-set; the age-derived schedule assessment stays acting-only.
  // Single view is byte-identical to the former requireSession()/profile.id path.
  const scope = await requireScope();
  return (
    <div data-testid="records-immunizations">
      <SectionSubtitle>
        Your vaccination record measured against a simplified CDC/ACIP schedule.
      </SectionSubtitle>
      <ImmunizationsSection
        scope={scope}
        searchParams={{
          sort: one(searchParams.sort),
          dir: one(searchParams.dir),
          status: one(searchParams.status),
        }}
      />
    </div>
  );
}
