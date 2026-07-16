import {
  episodeComparisonLine,
  type EpisodeComparison,
} from "@/lib/illness-episode-compare";

// The calm historical-duration line for an open episode (issue #856 item 10). Coaching
// tier: a quiet context card, never a notification or the dashboard hero (#449).
export default function EpisodeComparison({
  comparison,
}: {
  comparison: EpisodeComparison;
}) {
  return (
    <p
      className="mt-3 text-sm text-slate-500 dark:text-slate-400"
      data-testid="episode-comparison"
    >
      {episodeComparisonLine(comparison)}
    </p>
  );
}
