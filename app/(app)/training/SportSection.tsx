import { getSportByActivity } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { EmptyState } from "@/components/ui";
import SportExplorer from "@/components/SportExplorer";

// Sport records + trends. Sports are duration-only, so the detail is lighter
// than strength/cardio, but the explorer interaction matches them.
export default function SportSection() {
  const { profile } = requireSession();
  const sports = getSportByActivity(profile.id);
  if (sports.length === 0) {
    return (
      <EmptyState message="No sport logged yet. Log a tennis match, pickup game, or climb to see a summary." />
    );
  }

  return (
    <section>
      <SportExplorer sports={sports} />
    </section>
  );
}
