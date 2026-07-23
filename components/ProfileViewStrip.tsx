import { IconUsers, IconX } from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import Avatar from "@/components/Avatar";
import { setViewProfileAction } from "@/app/(app)/user-actions";

// The thin persistent multi-profile banner (issue #1096). It appears ONLY when the
// view is non-default — i.e. more than one profile is toggled into the view-set —
// and names every profile currently in view, with a quick "remove from view" (×) on
// each except the acting one (you can't hide the profile you're acting as). When the
// view collapses back to the single acting profile the strip renders nothing, so a
// single-profile session (and the default state of every multi-profile session) sees
// no chrome change at all — zero-regression.
//
// A Server Component: each × is a plain <form> bound to the setViewProfileAction
// Server Action, so it works pre-hydration (progressive enhancement) and needs no
// client JS. Rendered once in the app <main> (not a hidden md:* / md:hidden pair),
// so it shows identically on every viewport — the responsive-surface rule.
//
// #1013's "acting ≠ own" not-self banner is a FUTURE second non-default trigger for
// this same strip; until own-profile association lands, multi-view is the only
// non-default state, so that is the only trigger wired here.
export default function ProfileViewStrip({
  profiles,
  actingProfileId,
}: {
  // The in-view profiles, already disambiguated (#534) and in a stable order.
  profiles: SessionProfile[];
  actingProfileId: number;
}) {
  if (profiles.length <= 1) return null;
  return (
    <div
      data-testid="profile-view-strip"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50/70 px-3 py-2 text-sm dark:border-brand-500/30 dark:bg-brand-500/10"
    >
      <span className="flex items-center gap-1.5 font-medium text-brand-700 dark:text-brand-300">
        <IconUsers className="h-4 w-4 shrink-0" stroke={1.75} />
        Viewing {profiles.length} profiles
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {profiles.map((p) => {
          const isActing = p.id === actingProfileId;
          return (
            <span
              key={p.id}
              data-testid={`view-chip-${p.id}`}
              className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white/80 py-0.5 pl-1 pr-1.5 text-xs font-medium text-slate-700 dark:border-white/10 dark:bg-ink-850 dark:text-slate-200"
            >
              <Avatar profile={p} size="sm" />
              <span className="max-w-[10rem] truncate">{p.name}</span>
              {isActing ? (
                <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
                  Acting
                </span>
              ) : (
                <form action={setViewProfileAction} className="flex">
                  <input type="hidden" name="profileId" value={p.id} />
                  <button
                    type="submit"
                    data-testid={`view-chip-remove-${p.id}`}
                    aria-label={`Remove ${p.name} from view`}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-ink-750 dark:hover:text-slate-200"
                  >
                    <IconX className="h-3 w-3" stroke={2} />
                  </button>
                </form>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
