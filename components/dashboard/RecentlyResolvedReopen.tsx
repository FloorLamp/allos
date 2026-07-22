"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { IconRestore, IconX } from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { useToast } from "@/components/Toast";
import { useRouter } from "next/navigation";
import { reopenEpisodeAction } from "@/app/(app)/medical/episodes/actions";
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
}: {
  items: RecentlyResolvedItem[];
}) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const toast = useToast();
  const router = useRouter();

  const visible = items.filter((i) => !dismissed.has(i.episodeId));
  if (visible.length === 0) return null;

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
      router.refresh();
    });
  }

  function dismiss(episodeId: number) {
    setDismissed((prev) => new Set(prev).add(episodeId));
  }

  return (
    <section
      data-testid="recently-resolved-reopen"
      aria-label="Recently resolved illnesses"
      className="mb-6 flex flex-col gap-2"
    >
      {visible.map((item) => (
        <div
          key={item.episodeId}
          data-testid={`recently-resolved-${item.episodeId}`}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-black/5 bg-white/60 px-3 py-2 text-sm shadow-sm dark:border-white/10 dark:bg-black/10"
        >
          <Avatar profile={item.profile} size="sm" />
          <span className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">
            Recently resolved:{" "}
            <Link
              href={item.episodeHref}
              className="font-medium text-brand-700 hover:underline dark:text-brand-300"
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
            data-testid="recently-resolved-dismiss"
            className="shrink-0 rounded p-1 text-slate-400 transition hover:text-slate-600 dark:hover:text-slate-200"
            onClick={() => dismiss(item.episodeId)}
          >
            <IconX className="h-3.5 w-3.5" stroke={1.75} />
          </button>
        </div>
      ))}
    </section>
  );
}
