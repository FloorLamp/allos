import { IconVirus, IconChevronRight } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { openProfileAction } from "@/app/(app)/household/actions";

// One accessible profile with an OPEN illness episode + its pre-formatted "sick day N"
// line (built from the shared assembly via householdSickLine).
export interface SickHouseholdEntry {
  profile: AvatarProfile;
  line: string;
}

// "Sick in the household" dashboard widget (issue #801). Shows every profile the login
// can reach (grants-scoped upstream) that has an OPEN illness episode — regardless of
// which profile the viewer is currently acting as — so a caregiver sees "Mia · sick
// day 3 · 101.3°F" without switching. Each row taps through to switch-and-view (the
// same openProfileAction the Household strip uses). The page hides the whole widget
// when there are no open episodes (the transient `available` gate).
export default function SickHouseholdWidget({
  entries,
}: {
  entries: SickHouseholdEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="card" data-testid="sick-household">
      <div className="mb-3 flex items-center gap-1.5 section-label">
        <IconVirus className="h-4 w-4" stroke={1.75} aria-hidden="true" />
        Sick in the household
      </div>
      <ul className="flex flex-col gap-2">
        {entries.map(({ profile, line }) => (
          <li key={profile.id}>
            <form action={openProfileAction}>
              <input type="hidden" name="profileId" value={profile.id} />
              <button
                type="submit"
                data-testid={`sick-household-${profile.id}`}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-ink-850"
              >
                <Avatar profile={profile} size="sm" />
                <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
                  {line}
                </span>
                <IconChevronRight
                  className="h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600"
                  stroke={1.75}
                  aria-hidden="true"
                />
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
