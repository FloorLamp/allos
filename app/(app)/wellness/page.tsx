import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getWellnessPractices } from "@/lib/queries";
import { getWeekStart } from "@/lib/settings";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import RightSizeSuggestions from "@/components/RightSizeSuggestions";
import AddPracticeButton from "./AddPracticeButton";
import PracticeCard from "./PracticeCard";

export const dynamic = "force-dynamic";

export default async function WellnessPage(props: {
  searchParams: Promise<{ new?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const practices = getWellnessPractices(
    profile.id,
    todayStr,
    getWeekStart(profile.id)
  );

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="wellness-page"
    >
      <PageHeader
        title="Wellness"
        subtitle="Track recurring wellness routines such as sauna, meditation, breathwork, and light exposure."
        action={<AddPracticeButton defaultOpen={searchParams.new === "1"} />}
        actionAlign="start"
      />

      {/* Right-sizing suggestions (#1670), above the cards they are about: a weekly
          goal the profile has been under for four completed weeks, offered for the
          cadence they actually keep or for the logs-only state (#1621). */}
      <div className="mb-6">
        <RightSizeSuggestions profileId={profile.id} domain="practice" />
      </div>

      <section>
        <h2 className="mb-2 section-label">Your practices</h2>
        {practices.length === 0 ? (
          <EmptyState message="No practices yet. Add one to set a weekly goal and start logging sessions." />
        ) : (
          <div className="space-y-4">
            {practices.map((practice) => (
              <PracticeCard
                key={practice.identity}
                practice={practice}
                sessions={practice.sessions}
                today={todayStr}
              />
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
