import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { MONTHS_LONG } from "@/lib/date";
import type { MemberEpisodeStats } from "@/lib/care-trail";

// The per-member stats strip (#1373 Part 2): "Riley — 4 episodes this year · avg 5 days ·
// last: March". A FORMATTER over perMemberEpisodeStats (one computation over the same
// episodes the list renders). Rendered only in multi-view; a lonely member with no
// episodes still gets a line (absent data reads as "none yet", not a missing card).

// Locale-free month name (no server-locale leak — #964/#1020).
function monthName(ym: string | null): string | null {
  if (!ym) return null;
  const m = Number(ym.split("-")[1]);
  return MONTHS_LONG[m - 1] ?? null;
}

export default function CareTrailStatsStrip({
  stats,
  subjectById,
}: {
  stats: MemberEpisodeStats[];
  subjectById: Map<number, { name: string; profile: AvatarProfile }>;
}) {
  if (stats.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="care-trail-stats">
      {stats.map((s) => {
        const subject = subjectById.get(s.profileId);
        const parts: string[] = [
          `${s.episodesThisYear} episode${s.episodesThisYear === 1 ? "" : "s"} this year`,
        ];
        if (s.avgDurationDays != null)
          parts.push(`avg ${s.avgDurationDays} days`);
        const last = monthName(s.lastMonth);
        if (last) parts.push(`last: ${last}`);
        return (
          <div
            key={s.profileId}
            className="flex items-center gap-2 rounded-lg border border-black/10 bg-white/60 px-3 py-1.5 text-xs dark:border-white/10 dark:bg-ink-850"
            data-testid="care-trail-stat"
            data-profile-id={s.profileId}
          >
            {subject && <Avatar profile={subject.profile} size="sm" />}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {subject?.name ?? "—"}
            </span>
            <span className="text-slate-400">—</span>
            <span className="text-slate-500 dark:text-slate-400">
              {parts.join(" · ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
