import {
  IconUsers,
  IconChevronRight,
  IconCircleCheck,
} from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { openProfileAction } from "@/app/(app)/household/actions";

// One chip's data: a profile the caller can reach + its attention count.
export interface HouseholdStripEntry {
  profile: AvatarProfile;
  count: number;
}

// Tier-2 household strip (issue #171). A caregiver with multiple accessible
// profiles gets an at-a-glance row of their OTHER profiles' attention state without
// switching one at a time — each chip runs the SAME attention aggregation per
// profile (attentionCountForProfile) and taps through to switch-and-view (the same
// openProfileAction the Household page uses). Grants are respected upstream: the
// page only passes profiles from getAccessibleProfiles, and setActiveProfile
// re-checks on switch. Auto-hidden for single-profile logins (the page renders this
// only when 2+ profiles are accessible — same gate as the Household nav entry).
export default function HouseholdStrip({
  entries,
}: {
  entries: HouseholdStripEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section
      data-testid="household-strip"
      aria-label="Household"
      className="mb-6"
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <IconUsers className="h-4 w-4" stroke={1.75} aria-hidden="true" />
        Household
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map(({ profile, count }) => (
          <form key={profile.id} action={openProfileAction}>
            <input type="hidden" name="profileId" value={profile.id} />
            <button
              type="submit"
              data-testid={`household-chip-${profile.id}`}
              className="flex items-center gap-2 rounded-full border border-black/10 bg-white/70 py-1 pl-1 pr-3 text-sm transition hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900/70 dark:hover:bg-ink-850"
            >
              <Avatar profile={profile} size="sm" />
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {profile.name}
              </span>
              {count > 0 ? (
                <span
                  data-testid={`household-chip-count-${profile.id}`}
                  className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                >
                  {count}
                </span>
              ) : (
                <IconCircleCheck
                  className="h-4 w-4 text-emerald-500 dark:text-emerald-400"
                  stroke={1.75}
                  aria-label="All clear"
                />
              )}
              <IconChevronRight
                className="h-4 w-4 text-slate-300 dark:text-slate-600"
                stroke={1.75}
                aria-hidden="true"
              />
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}
