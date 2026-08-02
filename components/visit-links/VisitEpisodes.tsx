import Link from "next/link";
import { IconActivityHeartbeat } from "@tabler/icons-react";
import {
  linkEpisodeVisitAction,
  declineEpisodeVisitAction,
  unlinkEpisodeVisitAction,
} from "@/app/(app)/visit-link-actions";
import { episodeHref } from "@/lib/hrefs";
import type { EncounterEpisodeSuggestion } from "@/lib/visit-link-suggest";

// The encounter (visit) detail page's illness-episode surface (#1350) — the mirror of
// the episode page's "Care" line, from the visit side. Two parts:
//
//  1. The care trail: EVERY illness episode this visit is linked to (#1198 many-to-
//     many), each with the SHARED collapsed status line (#221, computed by the page)
//     and a deep-link into the episode view — a multi-visit illness reads as a trail.
//  2. "Link an illness episode?": the encounter-side link affordance the page lacked —
//     the episodes whose range CONTAINS this visit's date (the inverted #1196 proximity
//     engine), each an accept/dismiss the user confirms. This is what makes a fully-
//     unlinked visit that falls in an illness discoverable, instead of silent.
//
// Server component: every link/dismiss/unlink is a plain server-action <form> (no
// client JS), settling as a POST the e2e helpers await. `profileId` rides each form as
// the cross-profile write target; the actions gate write access.

export interface VisitEpisodeTrailItem {
  id: number;
  situation: string;
  // The shared #221 collapsed status ("sinus infection · Day 6"), computed by the page.
  statusLabel: string;
  worsening: boolean;
}

export default function VisitEpisodes({
  profileId,
  encounterId,
  trail,
  suggestion,
}: {
  profileId: number;
  encounterId: number;
  trail: VisitEpisodeTrailItem[];
  suggestion: EncounterEpisodeSuggestion | null;
}) {
  const suggestionEpisodes = suggestion?.episode
    ? [suggestion.episode]
    : (suggestion?.candidates ?? []);
  if (trail.length === 0 && suggestionEpisodes.length === 0) return null;

  return (
    <div className="mt-6 space-y-6" data-testid="visit-episodes">
      {trail.length > 0 ? (
        <section
          className="border-t border-black/5 pt-5 dark:border-white/5"
          data-testid="encounter-episode-trail"
        >
          <h2 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
            Illness episodes
          </h2>
          <ul className="divide-y divide-black/5 dark:divide-white/5">
            {trail.map((ep) => (
              <li
                key={ep.id}
                className="flex items-start justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0"
              >
                <Link
                  href={episodeHref(ep.id)}
                  data-testid="encounter-episode-trail-item"
                  className="inline-flex min-w-0 items-center gap-1.5 font-medium text-amber-700 transition hover:underline dark:text-amber-300"
                >
                  <IconActivityHeartbeat
                    className="h-4 w-4 shrink-0"
                    stroke={1.75}
                  />
                  <span className="min-w-0">
                    During illness episode: {ep.statusLabel}
                    {ep.worsening ? " · worsening" : ""}
                  </span>
                </Link>
                <form action={unlinkEpisodeVisitAction}>
                  <input type="hidden" name="profileId" value={profileId} />
                  <input type="hidden" name="episodeId" value={ep.id} />
                  <input type="hidden" name="encounterId" value={encounterId} />
                  <button
                    type="submit"
                    className="shrink-0 text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                  >
                    Unlink
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {suggestionEpisodes.length > 0 ? (
        <section
          className="border-l-2 border-brand-400 pl-4"
          data-testid="link-episode-to-visit"
        >
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Link an illness episode?
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            This visit falls during {suggestionEpisodes.length} illness episode
            {suggestionEpisodes.length === 1 ? "" : "s"}. Link it to keep the
            care trail together.
          </p>
          <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
            {suggestionEpisodes.map((ep) => (
              <li
                key={ep.id}
                className="flex flex-col items-start justify-between gap-3 py-3 text-sm first:pt-0 sm:flex-row sm:items-center"
              >
                <span className="min-w-0 text-slate-800 dark:text-slate-100">
                  {ep.situation}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={linkEpisodeVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input type="hidden" name="episodeId" value={ep.id} />
                    <input
                      type="hidden"
                      name="encounterId"
                      value={encounterId}
                    />
                    <button
                      type="submit"
                      data-testid="link-episode-suggestion"
                      className="btn btn-sm"
                    >
                      Link
                    </button>
                  </form>
                  <form action={declineEpisodeVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input type="hidden" name="episodeId" value={ep.id} />
                    <input
                      type="hidden"
                      name="encounterId"
                      value={encounterId}
                    />
                    <button type="submit" className="btn-ghost btn-sm">
                      Dismiss
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
