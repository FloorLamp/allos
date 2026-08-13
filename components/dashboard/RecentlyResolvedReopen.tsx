"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { IconRestore, IconX } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { useToast } from "@/components/Toast";
import { reopenEpisodeAction } from "@/app/(app)/medical/episodes/actions";
import HouseholdHistoryPromoLink from "@/components/dashboard/HouseholdHistoryPromoLink";
import type { AppRoute } from "@/lib/hrefs";

// Dashboard "Recently resolved — reopen?" affordance (issue #1140 Part A). A CALM,
// dismissible line beneath the illness hero for each accessible episode still inside its
// 7-day reopen window (driven by the SAME episodeReopenEligibility rule as the detail
// page — one computation). Cross-profile aware like the hero cockpits (#858): each row
// carries its own `profileId`, so a caregiver reopens a household member's episode without
// switching. This is a convenience, NOT a care-tier signal — it is collapsible/dismissible
// and never the non-hideable "Needs attention" hero (#449). One tap reopens the illness
// (restarting no meds — the med-restore checklist lives on the episode page, Part B); the
// row deep-links to the episode for the fuller reopen.
//
// THE DISMISSAL PERSISTS (issue #1548). It used to be client `useState` only, so a
// dismissed line came back on every reload for the rest of its 7-day window — the one
// X in the app that resurrected. The truth now lives server-side (a per-login id set;
// see lib/recently-resolved.ts), and `items` arrives ALREADY FILTERED; the local set
// below is only the optimistic hide between the click and the revalidation. What is
// persisted is the READER's hide, never the episode: reopen eligibility is untouched,
// and another login with access to the same profile still sees the line.
//
// IT ALSO CARRIES THE HOUSEHOLD-HISTORY PROMO (issue #1549) as a trailing footer row
// when the page says this band is the promo's contextual home — the reopen window is a
// strict subset of the promo's, so those two bands always co-occurred and stacked. The
// page decides the placement from the SERVER-side filtered list; when the viewer
// dismisses the last line here, the band keeps rendering the footer alone until the
// revalidation moves the link to the household strip, so the link never blinks out and
// never renders twice.
export interface RecentlyResolvedItem {
  profileId: number;
  episodeId: number;
  situation: string;
  displayName: string;
  crossProfile: boolean;
  profile: AvatarProfile;
  episodeHref: AppRoute;
}

export default function RecentlyResolvedReopen({
  items,
  showHouseholdPromo = false,
  dismissAction,
}: {
  // Already filtered server-side against this login's stored dismissals (#1548).
  items: RecentlyResolvedItem[];
  // True when THIS band is the household-history promo's contextual home (#1549) —
  // decided by the page, never by this component.
  showHouseholdPromo?: boolean;
  dismissAction: (episodeId: number) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  // How many dismissal writes have SETTLED, in the monotone-counter shape
  // AttentionHeroCard uses: the optimistic hide happens immediately, so neither a
  // reader nor a browser test can otherwise tell "stored" from "not sent yet", and a
  // plain pending flag starts idle and so matches the pre-click state. Advances
  // whether the write succeeded or failed — it reports that the attempt settled.
  const [savedCount, setSavedCount] = useState(0);
  const toast = useToast();

  const visible = items.filter((i) => !dismissed.has(i.episodeId));
  // The footer can outlive the lines for one revalidation (see the header note), so
  // an empty band with a promo still renders; an empty band without one renders
  // nothing at all.
  if (visible.length === 0 && !showHouseholdPromo) return null;

  function reopen(item: RecentlyResolvedItem) {
    setBusyId(item.episodeId);
    start(async () => {
      const fd = new FormData();
      fd.set("episodeId", String(item.episodeId));
      if (item.crossProfile) fd.set("profileId", String(item.profileId));
      const res = await reopenEpisodeAction(fd);
      setBusyId(null);
      if (!res.ok) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(`${item.situation} reopened.`);
    });
  }

  function dismiss(episodeId: number) {
    setDismissed((prev) => new Set(prev).add(episodeId));
    // Persist it (#1548). Fire-and-forget for the viewer — the row is already gone
    // from their screen and a failed write costs only the persistence, never the
    // line. The action revalidates "/", which is also what relocates the promo
    // footer once this was the last visible line.
    void dismissAction(episodeId).finally(() => setSavedCount((n) => n + 1));
  }

  return (
    <section
      data-testid="recently-resolved-reopen"
      aria-label="Recently resolved illnesses"
      data-saved-count={savedCount}
      className="mb-6 flex flex-col gap-2"
    >
      {visible.map((item) => (
        <div
          key={item.episodeId}
          data-testid={`recently-resolved-${item.episodeId}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-black/5 bg-white/60 px-3 py-2 text-sm shadow-xs dark:border-white/10 dark:bg-black/10"
        >
          <Avatar profile={item.profile} size="sm" />
          <span className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
            Recently resolved:{" "}
            <Link
              href={item.episodeHref}
              className="text-link"
              data-testid="recently-resolved-link"
            >
              {item.situation}
            </Link>
            {item.crossProfile ? (
              <span className="text-slate-500 dark:text-slate-400">
                {" "}
                · {item.displayName}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            data-testid="recently-resolved-reopen-btn"
            className="btn-ghost btn-sm"
            disabled={pending && busyId === item.episodeId}
            onClick={() => reopen(item)}
          >
            <IconRestore className="h-3.5 w-3.5" stroke={1.75} />
            {pending && busyId === item.episodeId ? "Reopening…" : "Reopen?"}
          </button>
          <button
            type="button"
            aria-label={`Dismiss recently resolved ${item.situation}`}
            title="Dismiss"
            data-testid="recently-resolved-dismiss"
            className="shrink-0 rounded-sm p-1 text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
            onClick={() => dismiss(item.episodeId)}
          >
            <IconX className="h-3.5 w-3.5" stroke={1.75} />
          </button>
        </div>
      ))}
      {/* The household-history promo's contextual home when reopen lines are on
          screen (#1549) — a trailing row of THIS band rather than a third sibling
          band beneath it. */}
      {showHouseholdPromo && (
        <div data-testid="recently-resolved-promo-row" className="px-1">
          <HouseholdHistoryPromoLink />
        </div>
      )}
    </section>
  );
}
