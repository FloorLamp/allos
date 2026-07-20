import { getProvidersForIndex } from "@/lib/queries";
import ProvidersIndex from "@/app/(app)/providers/ProvidersIndex";

// The providers registry index (issue #275; former /providers index, #1042 phase
// 6), now the #providers section of /records. Lists every provider on the
// instance (the registry is global) with the ACTIVE profile's activity count
// each, plus search + type filter. Reached from any linkified provider name.
// Individual providers link to /providers/[id], which survives at its own route.
export default function ProvidersSection({
  profileId,
  profileName,
}: {
  profileId: number;
  profileName: string;
}) {
  const providers = getProvidersForIndex(profileId);
  return <ProvidersIndex providers={providers} profileName={profileName} />;
}
