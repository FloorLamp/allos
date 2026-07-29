import { IconUsers, IconChevronRight } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import HouseholdHistoryPromoLink from "@/components/dashboard/HouseholdHistoryPromoLink";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
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
//
// It is ALSO the household-history promo's second home (issue #1549): in the 8–14-day
// tail — the promo window outlives the 7-day reopen window — or once the viewer has
// dismissed every reopen line, there is no reopen band to hang the link on, and a
// standalone block there would float context-free after the all-clear card. The link
// goes in this strip's label row instead, right-aligned, so the household band that is
// already on screen carries it.
//
// One caveat #1549's sketch didn't account for, and why `promo` alone can raise the
// section: the strip's chips are FILTERED to members with a non-zero attention count,
// so a multi-profile login whose household is quiet renders no chips at all — exactly
// the state the 8–14-day tail tends to be in. Were the section still gated on chips,
// the link would have had no anchor and would simply have vanished. So the section
// renders when it has chips OR the promo; the chip row itself still renders only when
// there are chips.
export default function HouseholdStrip({
  entries,
  showHouseholdPromo = false,
}: {
  entries: HouseholdStripEntry[];
  // True when THIS strip is the household-history promo's contextual home (#1549) —
  // decided by the page, never by this component.
  showHouseholdPromo?: boolean;
}) {
  if (entries.length === 0 && !showHouseholdPromo) return null;
  // Two accessible profiles can share a name — append a "(2)" ordinal so each chip
  // names a specific profile rather than a same-name twin (#534).
  const displayNames = disambiguateProfileNames(entries.map((e) => e.profile));
  return (
    <section
      data-testid="household-strip"
      aria-label="Household"
      className="mb-6"
    >
      {/* The label ROW, not just the label: the promo shares it, right-aligned, and
          wraps beneath on a narrow phone rather than squeezing either side. */}
      <div
        data-testid="household-strip-header"
        className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        <div className="flex items-center gap-1.5 section-label">
          <IconUsers className="h-4 w-4" stroke={1.75} aria-hidden="true" />
          Household
        </div>
        {showHouseholdPromo && <HouseholdHistoryPromoLink />}
      </div>
      {entries.length > 0 && (
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
                  {displayNames.get(profile.id) ?? profile.name}
                </span>
                <span
                  data-testid={`household-chip-count-${profile.id}`}
                  className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
                >
                  {count}
                </span>
                <IconChevronRight
                  className="h-4 w-4 text-slate-300 dark:text-slate-600"
                  stroke={1.75}
                  aria-hidden="true"
                />
              </button>
            </form>
          ))}
        </div>
      )}
    </section>
  );
}
