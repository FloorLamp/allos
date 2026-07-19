import { redirect } from "next/navigation";
import Link from "next/link";
import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { getUnitPrefs } from "@/lib/settings";
import { gatherHouseholdHistory } from "@/lib/household-history";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import HouseholdHistoryTimeline from "@/components/household/HouseholdHistoryTimeline";

export const dynamic = "force-dynamic";

// The merged household visit + illness-episode history (issue #1009 Ask 1). Gated the
// SAME way as /household itself — open to any login that can reach 2+ profiles (an
// admin, or a caregiver member with several grants); a single-profile login has no
// household to merge, so it's bounced to the dashboard (the server gate is
// authoritative — the nav/header links only hide it cosmetically).
//
// The AUTH decision lives here (getAccessibleProfiles = the household strip's access
// basis); the auth-blind gather takes the resolved id set and merges each profile's
// existing profile-scoped reads into one date-ordered, person-tagged stream. The
// merged view AND the per-person filter are the same list (one computation) — the
// client toggle just filters it.
export default async function HouseholdHistoryPage() {
  const { login } = await requireSession();
  const profiles = await getAccessibleProfiles();
  if (profiles.length < 2) redirect("/");

  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;
  const items = gatherHouseholdHistory(profiles.map((p) => p.id));

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Household history"
        subtitle="Everyone's past visits and illness episodes in one place — filter to one person, or see the whole house."
        action={
          <Link
            href="/household"
            className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
            data-testid="household-history-back"
          >
            ← Household
          </Link>
        }
      />
      <HouseholdHistoryTimeline
        items={items}
        profiles={profiles}
        temperatureUnit={temperatureUnit}
      />
    </PageContainer>
  );
}
