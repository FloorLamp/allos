import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getAllPracticeSessions,
  getWellnessPractices,
} from "@/lib/practice-store";
import { PageHeader, EmptyState } from "@/components/ui";
import PracticeEditor from "./PracticeEditor";
import PracticeCard from "./PracticeCard";

export const dynamic = "force-dynamic";

export default async function WellnessPage() {
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const practices = getWellnessPractices(profile.id);

  return (
    <div>
      <PageHeader
        title="Wellness"
        subtitle="Define and log practices such as sauna, meditation, breathwork, and light exposure—independent of any protocol."
      />

      <section className="mb-8">
        <h2 className="mb-2 section-label">Add a practice</h2>
        <PracticeEditor />
      </section>

      <section>
        <h2 className="mb-2 section-label">Your practices</h2>
        {practices.length === 0 ? (
          <EmptyState message="No wellness practices yet. Add one above to start a weekly target and session history." />
        ) : (
          <div className="space-y-4">
            {practices.map((practice) => (
              <PracticeCard
                key={practice.identity}
                practice={practice}
                sessions={getAllPracticeSessions(
                  profile.id,
                  practice.name,
                  200
                )}
                today={todayStr}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
