import { getSportByActivity } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { EmptyState } from "@/components/ui";
import SportExplorer from "@/components/SportExplorer";

// UNMOUNTED since #1492. This section (and the full-history explorer it hosts) was
// only ever rendered by Trends → Fitness, which became the WINDOWED analytics lens:
// "analyze on Trends, do on /training". Its capabilities live on /training →
// Analyze (the picker + per-item detail panel — the explorer triplet's fourth
// sibling), which #1491 item 3 converges these three onto. Kept, not deleted, so
// that convergence has its subjects; /training page changes are out of #1492's
// scope, so nothing re-mounts it here.
// Sport records + trends. Sports are duration-only, so the detail is lighter
// than strength/cardio, but the explorer interaction matches them.
export default async function SportSection() {
  const { login, profile } = await requireSession();
  const sports = getSportByActivity(
    profile.id,
    getDisplayFormatPrefs(login.id)
  );
  if (sports.length === 0) {
    return (
      <EmptyState
        message="No sport logged yet. Log a tennis match, pickup game, or climb to see a summary."
        action={{ href: "/training?tab=log", label: "Go to Log" }}
      />
    );
  }

  return (
    <section>
      <SportExplorer sports={sports} />
    </section>
  );
}
