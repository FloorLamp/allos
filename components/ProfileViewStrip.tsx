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
// Whether the strip renders at all — the ONE predicate. The app shell reads it
// to decide whether to hand the strip to <ShellChrome> (which owns the sticky
// placement and the content container's top padding when it does), and the
// component itself is still the authority on its own emptiness. Two places
// asking "is the view non-default?" must never be able to disagree.
export function viewStripVisible(profiles: SessionProfile[]): boolean {
  return profiles.length > 1;
}

export default function ProfileViewStrip({
  profiles,
  actingProfileId,
}: {
  // The in-view profiles, already disambiguated (#534) and in a stable order.
  profiles: SessionProfile[];
  actingProfileId: number;
}) {
  if (!viewStripVisible(profiles)) return null;
  return (
    // One line on a phone, wrapping from `sm` up (issue #1416, section C): the
    // strip is now STICKY on mobile, so every extra line it wraps to is a line
    // permanently taken off the page. The chips scroll horizontally instead.
    // The vertical margin moved to the ShellChrome wrapper, which owns spacing
    // in both placements.
    //
    // NO CARD BELOW `md` (issue #1539). Since the move into the ShellChrome band
    // the strip was a bordered, tinted, rounded card floating inside a bordered,
    // blurred bar, with 12px of wrapper padding either side of it — a card with
    // outer padding inside a surface that is already a surface, and two stacked
    // translucent layers page content bled through. Below `md` the BAND is the
    // surface (it carries the brand wash edge-to-edge, see ShellChrome) and the
    // strip is bare bar content; from `md` up the band is transparent, so the card
    // styling returns and desktop is byte-identical. One tree, responsive classes
    // only — never a hidden md:* / md:hidden pair.
    <div
      data-testid="profile-view-strip"
      className="flex items-center gap-2 overflow-x-auto text-sm sm:flex-wrap sm:overflow-x-visible md:rounded-lg md:border md:border-brand-200 md:bg-brand-50/70 md:px-3 md:py-2 md:dark:border-brand-500/30 md:dark:bg-brand-500/10"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium text-brand-700 dark:text-brand-300">
        <IconUsers className="h-4 w-4 shrink-0" stroke={1.75} />
        {/* The label costs 146px of a 356px row at 390px — 41% of the space, spent
            restating what the chips beside it already say (the names AND the
            count), which is what pushed the second chip off the right edge with no
            scroll affordance. Below `md` the IconUsers carries it visually and the
            words stay in the accessibility tree, so a screen reader still hears
            "Viewing 2 profiles". */}
        <span data-testid="view-strip-label" className="sr-only md:not-sr-only">
          Viewing {profiles.length} profiles
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1.5 sm:flex-wrap">
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
                    title="Remove from view"
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
