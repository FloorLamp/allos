import { requireSession } from "@/lib/auth";
import { getResolvedCrisisResources } from "@/lib/settings";
import PageContainer from "@/components/PageContainer";
import { PageHeader } from "@/components/ui";
import CrisisResources from "@/components/CrisisResources";

export const dynamic = "force-dynamic";

// The PASSIVE crisis-resource surface (issue #996): always reachable regardless of
// state, never buried behind a data trigger. It renders the operator-configured
// crisis line(s) (or the neutral fallback) plus calm guidance — the app surfaces a
// resource, it never intervenes, contacts anyone, or transmits the fact that this
// page was viewed. The resources are resolved from the ACTIVE profile's own settings
// (per-profile override > global default), so nothing crosses profiles.
export default async function CrisisResourcesPage() {
  const { profile, login } = await requireSession();
  const resources = getResolvedCrisisResources(profile.id);
  const isAdmin = login.role === "admin";

  return (
    <PageContainer width="reading" className="mx-auto space-y-6">
      <PageHeader
        title="Crisis support"
        subtitle="If things feel like too much, these resources are here whenever you need them."
      />
      <div className="card space-y-3">
        <CrisisResources resources={resources} isAdmin={isAdmin} />
      </div>
    </PageContainer>
  );
}
