import Link from "next/link";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { HOUSEHOLD_HISTORY_HREF, episodeHref } from "@/lib/hrefs";
import type { HouseholdEpisodeContext } from "@/lib/household-history";
import { formatDateShape, type DisplayFormatPrefs } from "@/lib/format-date";

// The household-context card on an illness-episode page (issue #1009 Ask 3). A compact,
// CALM read (never a notification, never a finding) that answers "did this go around the
// house?" — other accessible members' episodes that overlap or closely precede/follow
// THIS episode's window, each a dated FACT ("overlapped by 4 days", never "caught it
// from"). Grant-scoped upstream (the page passes only the viewing login's accessible
// members); the page renders this only when there IS context, so this component assumes
// a non-empty list and never shows an empty shell.

// Pref-aware (#964/#1020): month-day in the viewer's shape via formatDateShape,
// replacing the old implicit-locale toLocaleDateString (a server-locale leak).
function fmtDate(d: string | null, prefs: DisplayFormatPrefs): string {
  if (!d) return "—";
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : formatDateShape(
        prefs.dateFormat,
        dt.getUTCFullYear(),
        dt.getUTCMonth() + 1,
        dt.getUTCDate(),
        { monthStyle: "short" }
      );
}

// The dated relation phrase — a fact, no causality.
function relationPhrase(ctx: HouseholdEpisodeContext): string {
  if (ctx.relation === "overlap") {
    return ctx.days === 1
      ? "overlapped by 1 day"
      : `overlapped by ${ctx.days} days`;
  }
  const when = ctx.relation === "before" ? "before" : "after";
  if (ctx.days === 0) return `just ${when}`;
  return ctx.days === 1 ? `1 day ${when}` : `${ctx.days} days ${when}`;
}

export default function HouseholdEpisodeContextCard({
  contexts,
  profilesById,
  nameFor,
  formatPrefs,
}: {
  contexts: HouseholdEpisodeContext[];
  profilesById: Map<number, AvatarProfile>;
  nameFor: (id: number) => string;
  formatPrefs: DisplayFormatPrefs;
}) {
  return (
    <section className="card space-y-3" data-testid="episode-household-context">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Around the household
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Other members&rsquo; illnesses near this one&rsquo;s dates — timing
          only, not a cause.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {contexts.map((ctx) => {
          const p = profilesById.get(ctx.profileId);
          const range = `${fmtDate(ctx.firstDay, formatPrefs)}–${
            ctx.ongoing ? "ongoing" : fmtDate(ctx.lastActiveDay, formatPrefs)
          }`;
          return (
            <li key={`${ctx.profileId}-${ctx.episodeId}`}>
              <Link
                href={episodeHref(ctx.episodeId)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-slate-100 dark:hover:bg-ink-750"
                data-testid="episode-household-context-row"
                data-profile-id={ctx.profileId}
              >
                {p && <Avatar profile={p} size="sm" />}
                <span className="min-w-0">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {nameFor(ctx.profileId)}
                  </span>{" "}
                  <span className="text-slate-500 dark:text-slate-400">
                    was sick {range} — {relationPhrase(ctx)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <Link
        href={HOUSEHOLD_HISTORY_HREF}
        className="inline-block text-sm font-medium text-sky-700 hover:underline dark:text-sky-300"
        data-testid="episode-household-context-link"
      >
        View household history →
      </Link>
    </section>
  );
}
