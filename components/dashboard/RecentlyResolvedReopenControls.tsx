"use client";

import { useState, useTransition } from "react";
import Button from "@/components/Button";
import { useToast } from "@/components/Toast";
import { reopenEpisodeAction } from "@/app/(app)/medical/episodes/actions";
import type { AvatarProfile } from "@/components/Avatar";
import type { AppRoute } from "@/lib/hrefs";

// "Recently resolved — reopen?" (issue #1140 Part A), as the two controls a dashboard
// ROW earns (#4076). The line itself — who, which episode, and its door — is the row
// the canvas draws; what needs a client is only the pair of writes, because each can
// legitimately refuse and each answers from a typed outcome. Cross-profile aware like
// illness context (#858): the item carries its own `profileId`, so a caregiver
// reopens a household member's episode without switching.
//
// THE DISMISSAL PERSISTS (issue #1548). It used to be client `useState` only, so a
// dismissed line came back on every reload for the rest of its 7-day window — the one
// X in the app that resurrected. The truth now lives server-side (a per-login id set;
// see lib/recently-resolved.ts), and the item arrives ALREADY FILTERED; the local flag
// below is only the optimistic hide between the click and the revalidation. What is
// persisted is the READER's hide, never the episode: reopen eligibility is untouched,
// and another login with access to the same profile still sees the line.
export interface RecentlyResolvedItem {
  profileId: number;
  episodeId: number;
  situation: string;
  displayName: string;
  crossProfile: boolean;
  profile: AvatarProfile;
  episodeHref: AppRoute;
}

export default function RecentlyResolvedReopenControls({
  item,
  dismissAction,
}: {
  item: RecentlyResolvedItem;
  dismissAction: (episodeId: number) => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [pending, start] = useTransition();
  // How many dismissal writes have SETTLED. The optimistic hide happens immediately,
  // so neither a reader nor a browser test can otherwise tell "stored" from "not sent
  // yet", and a plain pending flag starts idle and matches the pre-click state.
  // Advances whether the write succeeded or failed — it reports that the attempt
  // settled.
  const [savedCount, setSavedCount] = useState(0);
  const toast = useToast();

  if (dismissed) return null;

  return (
    <span
      data-testid="recently-resolved-reopen"
      data-saved-count={savedCount}
      className="inline-flex items-center gap-1"
    >
      <Button
        data-testid="recently-resolved-reopen-btn"
        disabled={pending}
        pendingLabel="Reopening…"
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set("episodeId", String(item.episodeId));
            if (item.crossProfile) fd.set("profileId", String(item.profileId));
            const res = await reopenEpisodeAction(fd);
            if (!res.ok) {
              toast(res.error, { tone: "error" });
              return;
            }
            toast(`${item.situation} reopened.`);
          })
        }
      >
        Reopen?
      </Button>
      <Button
        aria-label={`Dismiss recently resolved ${item.situation}`}
        data-testid="recently-resolved-dismiss"
        onClick={() => {
          setDismissed(true);
          // Persist it (#1548). Fire-and-forget for the viewer — the row is already
          // gone from their screen and a failed write costs only the persistence.
          void dismissAction(item.episodeId).finally(() =>
            setSavedCount((n) => n + 1)
          );
        }}
      >
        Hide
      </Button>
    </span>
  );
}
