import { getGroupedProviderDirectory } from "@/lib/queries";
import GroupedProvidersIndex from "@/app/(app)/providers/GroupedProvidersIndex";

// The providers registry index (issue #275; former /providers index, #1042 phase
// 6), now the #providers section of /records. As of #1055 it is the GROUPED,
// activity-aware directory: organizations as cards with their affiliated individuals
// nested, unaffiliated individuals separate, archived behind a disclosure, recency
// sorted. Falls back to a flat list when no affiliation edges exist yet. Every
// provider on the instance is listed (the registry is global); the activity counts
// are the ACTIVE profile's. Individual rows link to /providers/[id].
export default function ProvidersSection({
  profileId,
  profileName,
}: {
  profileId: number;
  profileName: string;
}) {
  const directory = getGroupedProviderDirectory(profileId);
  return (
    <GroupedProvidersIndex directory={directory} profileName={profileName} />
  );
}
