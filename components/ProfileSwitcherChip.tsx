import Link from "next/link";
import { IconChevronRight } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { switchProfileAction } from "@/app/(app)/profile-context-actions";
import type { AppRoute } from "@/lib/hrefs";

// A profile-aware destination chip. The acting profile gets a normal link; another
// accessible profile gets an explicit switch-and-open button through the same
// setActiveProfile boundary as the header switcher. This keeps profile-owned
// destinations honest without silently changing who the login is acting as.
export default function ProfileSwitcherChip({
  profile,
  acting,
  destination,
  label,
  detail = profile.name,
  badge,
  badgeTestId,
  testId,
}: {
  profile: AvatarProfile;
  acting: boolean;
  destination: AppRoute;
  label: string;
  detail?: string | null;
  badge?: number;
  badgeTestId?: string;
  testId?: string;
}) {
  const content = (
    <>
      <Avatar profile={profile} size="sm" />
      <span className="min-w-0 flex-1 truncate text-left">
        <span className="font-medium text-slate-700 dark:text-slate-200">
          {label}
        </span>
        {detail && (
          <span className="text-slate-500 dark:text-slate-400">
            {" "}
            · {detail}
          </span>
        )}
      </span>
      {badge != null && (
        <span
          data-testid={badgeTestId}
          className="rounded-full bg-rose-100 px-1.5 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
        >
          {badge}
        </span>
      )}
      <IconChevronRight
        className="h-4 w-4 shrink-0 text-slate-300 dark:text-slate-600"
        stroke={1.75}
        aria-hidden="true"
      />
    </>
  );
  const className =
    "inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-black/10 bg-white/70 py-1 pl-1 pr-2 text-sm transition hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900/70 dark:hover:bg-ink-850";

  if (acting) {
    return (
      <Link
        href={destination}
        className={className}
        aria-label={`Open ${label} for ${profile.name}`}
        data-testid={testId}
      >
        {content}
      </Link>
    );
  }

  return (
    <form action={switchProfileAction}>
      <input type="hidden" name="profileId" value={profile.id} />
      <input type="hidden" name="returnTo" value={destination} />
      <button
        type="submit"
        className={className}
        aria-label={`Switch to ${profile.name} and open ${label}`}
        data-testid={testId}
      >
        {content}
      </button>
    </form>
  );
}
