import Link from "next/link";
import {
  linkEpisodeVisitAction,
  declineEpisodeVisitAction,
  unlinkEpisodeVisitAction,
} from "@/app/(app)/visit-links/actions";
import { encounterHref } from "@/lib/hrefs";
import type { LinkedEncounterRef } from "@/lib/queries";
import type { EpisodeVisitSuggestion } from "@/lib/visit-link-suggest";

// The illness-episode cockpit's "Care" line (#1053; many-model #1198): the SET of visits
// for this episode — each linked visit listed (date-ordered) with its own Unlink, plus
// the in-range suggestion and the "Link a visit…" picker to ADD more. Server component;
// every action is a plain server-action <form> (no client JS). `profileId` rides each
// post as the cross-profile write target.

export interface CareVisitOption {
  id: number;
  label: string; // "Office Visit · Mar 4"
  inRange: boolean;
}

export default function EpisodeCareLine({
  profileId,
  episodeId,
  careVisits,
  suggestion,
  manualOptions,
  canWrite,
}: {
  profileId: number;
  episodeId: number;
  careVisits: LinkedEncounterRef[];
  suggestion: EpisodeVisitSuggestion | null;
  manualOptions: CareVisitOption[];
  canWrite: boolean;
}) {
  // Nothing to show when there are no linked visits, no in-range suggestion, and the
  // reader can't link one manually.
  if (
    careVisits.length === 0 &&
    !suggestion &&
    (!canWrite || manualOptions.length === 0)
  )
    return null;

  const linkForm = (encounterId: number, label: string) => (
    <form action={linkEpisodeVisitAction} key={`link-${encounterId}`}>
      <input type="hidden" name="profileId" value={profileId} />
      <input type="hidden" name="episodeId" value={episodeId} />
      <input type="hidden" name="encounterId" value={encounterId} />
      <button
        type="submit"
        className="text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
      >
        {label}
      </button>
    </form>
  );

  return (
    <section
      className="rounded-xl border border-black/5 bg-white/60 p-4 shadow-sm dark:border-white/10 dark:bg-black/10"
      data-testid="episode-care"
    >
      <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        Care
      </h2>

      {careVisits.length > 0 ? (
        <div className="mb-3 space-y-1.5" data-testid="episode-care-visits">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {careVisits.length === 1
              ? "Visit during this episode"
              : "Visits during this episode"}
          </p>
          <ul className="space-y-1.5">
            {careVisits.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-slate-800 dark:text-slate-100">
                  <Link
                    href={encounterHref(v.id)}
                    className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                    data-testid="episode-care-link"
                  >
                    {v.type || "Visit"} · {v.date}
                    {v.providerName ? ` — ${v.providerName}` : ""}
                  </Link>
                </span>
                {canWrite ? (
                  <form action={unlinkEpisodeVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input type="hidden" name="episodeId" value={episodeId} />
                    <input type="hidden" name="encounterId" value={v.id} />
                    <button
                      type="submit"
                      className="shrink-0 text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      Unlink
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggestion || (canWrite && manualOptions.length > 0) ? (
        <div className="space-y-2" data-testid="episode-care-suggestion">
          {suggestion?.encounter ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-700 dark:text-slate-200">
                A visit during this episode looks related — link it?
              </span>
              {canWrite ? (
                <div className="flex shrink-0 items-center gap-3">
                  {linkForm(suggestion.encounter.id, "Link this visit")}
                  <form action={declineEpisodeVisitAction}>
                    <input type="hidden" name="profileId" value={profileId} />
                    <input type="hidden" name="episodeId" value={episodeId} />
                    <input
                      type="hidden"
                      name="encounterId"
                      value={suggestion.encounter.id}
                    />
                    <button
                      type="submit"
                      className="text-xs font-medium text-slate-400 transition hover:text-rose-600 dark:hover:text-rose-400"
                    >
                      Dismiss
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
          ) : suggestion?.candidates ? (
            <div className="text-sm">
              <p className="text-slate-700 dark:text-slate-200">
                {suggestion.candidates.length} visits fall in this episode —
                pick one:
              </p>
              {canWrite ? (
                <ul className="mt-2 space-y-1">
                  {suggestion.candidates.map((c) => (
                    <li key={c.id}>
                      {linkForm(
                        c.id,
                        manualOptions.find((o) => o.id === c.id)?.label ??
                          `Visit · ${c.date}`
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {canWrite && manualOptions.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400">
                Link a visit…
              </summary>
              <ul className="mt-2 space-y-1" data-testid="episode-care-manual">
                {manualOptions.map((o) => (
                  <li key={o.id} className="flex items-center gap-2">
                    {linkForm(o.id, o.label)}
                    {o.inRange ? (
                      <span className="text-xs font-medium uppercase text-emerald-600 dark:text-emerald-400">
                        in range
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
