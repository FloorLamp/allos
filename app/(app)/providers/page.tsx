import { requireSession } from "@/lib/auth";
import { getProvidersForIndex } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import ProvidersIndex from "./ProvidersIndex";

export const dynamic = "force-dynamic";

// The providers registry index (issue #275). Lists every provider on the instance
// (the registry is global) with the ACTIVE profile's activity count each, plus
// search + type filter. Reached from the Medical group nav and from any linkified
// provider name. Individual providers link to /providers/[id].
export default async function ProvidersPage() {
  const { profile } = await requireSession();
  const providers = getProvidersForIndex(profile.id);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Providers"
        subtitle="Your shared registry of clinicians and organizations. Record counts are for the active profile."
      />
      <ProvidersIndex providers={providers} profileName={profile.name} />
    </div>
  );
}
