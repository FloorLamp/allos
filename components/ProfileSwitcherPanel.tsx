"use client";

import { IconEye, IconEyeOff } from "@tabler/icons-react";
import type { SessionProfile } from "@/lib/auth";
import Avatar from "@/components/Avatar";
import {
  switchProfileAction,
  setViewProfileAction,
} from "@/app/(app)/user-actions";

// THE switcher panel's content (issue #1801) — one component, both viewports.
//
// The mobile top drawer and the desktop sidebar expando are two PRESENTATIONS of
// this list (see ProfileIdentityBar); the list itself is authored once, per the
// responsive-variants rule. There is deliberately no `md:` anything in here: a
// hidden desktop twin is exactly the drift that let the mobile drawer and the
// desktop sidebar disagree about the profile switcher before #794.
//
// TWO VERBS, TWO CONTROLS — the rule the row layout exists to enforce:
//
//   * SWITCH TO (the name button) changes the ACTING profile: the write target,
//     the "whose settings apply" anchor. It posts switchProfileAction, i.e. the
//     same setActiveProfile() boundary every other switch affordance uses (the
//     household strip chips, ProfileSwitcherChip). #1801 moves where these
//     controls live; it adds no write path.
//   * SHOW IN VIEW (the eye) changes only the READ overlay — the #1096 view-set,
//     persisted on the session and re-validated against the login's grants on
//     every resolution.
//
// One ambiguous tap that did both would be the wrong-profile-write risk #1013
// is about, so the two stay separate controls with separate accessible names.
//
// The acting profile's eye is rendered checked and DISABLED: you cannot un-view
// the profile you are acting as (toggleViewProfile refuses it server-side too —
// this is the UI half of the same invariant, not a second rule).
export default function ProfileSwitcherPanel({
  profiles,
  actingProfileId,
  viewIds,
  readOnlyIds,
  onSelect,
}: {
  // Every ACCESSIBLE profile, with disambiguated names (#534) — resolved once by
  // the app shell from ProfileScope and passed down as data.
  profiles: SessionProfile[];
  actingProfileId: number;
  // The persisted, access-validated view-set (#1096).
  viewIds: number[];
  // Profiles this login holds only READ access on (issue #33). Each carries the
  // read-only hint on its own row, so "why can't I edit here?" is answerable
  // before switching rather than after.
  readOnlyIds: number[];
  // Lets the presentation close itself after a switch. Deliberately NOT wired to
  // the view toggle: toggling several profiles into view in one visit is the
  // normal case, and closing the panel under the finger each time would make it
  // one profile per open.
  onSelect?: () => void;
}) {
  const readOnly = new Set(readOnlyIds);
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-xs text-slate-500 dark:text-slate-400">
        Tap a name to act as them. Toggle the eye to show a profile in your
        view.
      </p>
      {profiles.map((p) => {
        const isActing = p.id === actingProfileId;
        const inView = isActing || viewIds.includes(p.id);
        return (
          <div
            key={p.id}
            data-testid={`switcher-row-${p.id}`}
            className="flex items-center gap-1"
          >
            <form action={switchProfileAction} className="min-w-0 flex-1">
              <input type="hidden" name="profileId" value={p.id} />
              <button
                type="submit"
                data-testid={`switch-to-${p.id}`}
                aria-current={isActing ? "true" : undefined}
                onClick={() => {
                  // The switch-time device-local cleanup is centralized in
                  // ProfileSwitchWatcher (#600) — it wipes the previous profile's
                  // emergency card whenever the active profile id changes, so
                  // EVERY switch affordance is covered by construction rather
                  // than each hand-mirroring the wipe here.
                  onSelect?.();
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition ${
                  isActing
                    ? "bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
                }`}
              >
                <Avatar profile={p} size="sm" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {readOnly.has(p.id) && (
                  // The #33 hint on the ROW, so it is attached to the profile it
                  // describes rather than only to the acting one. Server-side
                  // requireWriteAccess() is the real boundary; this is the hint
                  // that makes the missing edit affordances read as intentional.
                  <span
                    data-testid={`switcher-read-only-${p.id}`}
                    aria-label={`${p.name} — read-only`}
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                      isActing
                        ? "bg-white/20 text-white"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    }`}
                  >
                    Read-only
                  </span>
                )}
              </button>
            </form>
            <form action={setViewProfileAction} className="shrink-0">
              <input type="hidden" name="profileId" value={p.id} />
              <button
                type="submit"
                disabled={isActing}
                data-testid={`view-toggle-${p.id}`}
                aria-pressed={inView}
                aria-label={
                  isActing
                    ? `${p.name} is always in your view`
                    : inView
                      ? `Remove ${p.name} from view`
                      : `Add ${p.name} to view`
                }
                title={
                  isActing
                    ? "Always in view"
                    : inView
                      ? "In view — tap to hide"
                      : "Not in view — tap to show"
                }
                className={`flex h-8 w-8 items-center justify-center rounded-md border transition disabled:opacity-40 ${
                  inView
                    ? "border-brand-300 bg-brand-50 text-brand-600 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
                    : "border-black/10 text-slate-400 hover:bg-slate-100 dark:border-white/10 dark:hover:bg-ink-750"
                }`}
              >
                {inView ? (
                  <IconEye className="h-4 w-4" stroke={1.75} />
                ) : (
                  <IconEyeOff className="h-4 w-4" stroke={1.75} />
                )}
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}
