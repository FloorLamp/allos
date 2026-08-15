"use client";

import Link from "next/link";
import { episodeHref } from "@/lib/hrefs";
import { formatRecordDate } from "@/lib/record-format";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { EpisodeLinkRef } from "@/lib/queries";

// One compact treatment for the reverse half of an illness-episode association.
// The episode's start date disambiguates repeated "Illness" episodes without making
// every single-link row verbose. Unknown-start episodes occur only for stable promoted
// condition links (date-derived associations deliberately exclude them).
export default function EpisodeLinks({
  episodes,
  label = "During illness episode",
  testId,
  className = "",
}: {
  episodes: readonly EpisodeLinkRef[];
  label?: string;
  testId?: string;
  className?: string;
}) {
  const fmt = useFormatPrefs();
  if (episodes.length === 0) return null;
  return (
    <div
      className={`mt-0.5 text-xs font-normal text-slate-500 dark:text-slate-400 ${className}`}
      data-testid={testId}
    >
      {label}:{" "}
      {episodes.map((episode, index) => (
        <span key={episode.id}>
          {index > 0 ? ", " : null}
          <Link
            href={episodeHref(episode.id)}
            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            {episode.situation}
            {episodes.length > 1 && episode.start_date
              ? ` (${formatRecordDate(episode.start_date, "", fmt)})`
              : ""}
          </Link>
        </span>
      ))}
    </div>
  );
}
