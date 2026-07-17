"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconClockQuestion } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import {
  endStaleEpisodeAction,
  dismissStaleNudgeAction,
} from "@/app/(app)/medical/episodes/actions";

// The SUGGEST-ONLY stale-open-episode nudge (issue #859 item 1). Shown on the episode
// page + hero cockpit when an open episode has gone quiet for N days. Offers a one-tap
// BACKDATED end (as of the last activity day) or a "Keep open" dismissal — it NEVER
// auto-closes (#560). Carries the episode id AND, for a household member's cockpit, the
// target profileId so the actions gate on THAT profile (requireProfileWriteAccess). Both
// buttons answer from the action's typed outcome — never an unconditional confirm.
export default function StaleEpisodeNudge({
  episodeId,
  profileId,
  lastActivityDate,
  quietDays,
}: {
  episodeId: number;
  profileId?: number;
  lastActivityDate: string;
  quietDays: number;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const withTarget = (fd: FormData) => {
    fd.set("episodeId", String(episodeId));
    if (profileId != null) fd.set("profileId", String(profileId));
    return fd;
  };

  return (
    <div
      data-testid="stale-episode-nudge"
      className="mt-3 rounded-xl border border-amber-500/30 bg-amber-50/60 p-3 text-sm dark:border-amber-500/25 dark:bg-amber-950/20"
    >
      <p className="flex items-start gap-2 text-slate-700 dark:text-slate-200">
        <IconClockQuestion
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          stroke={1.75}
        />
        <span>
          Still sick? Nothing has been logged for {quietDays} days. End this
          episode as of {lastActivityDate}?
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="stale-episode-end"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const fd = withTarget(new FormData());
              fd.set("lastActiveDay", lastActivityDate);
              const res = await endStaleEpisodeAction(fd);
              if (!res.ok) {
                toast(res.error, { tone: "error" });
                return;
              }
              toast(`Episode ended as of ${lastActivityDate}.`);
              router.refresh();
            })
          }
          className="badge cursor-pointer border border-amber-500/40 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:bg-ink-900 dark:text-amber-300"
        >
          {pending ? "Ending…" : `End as of ${lastActivityDate}`}
        </button>
        <button
          type="button"
          data-testid="stale-episode-dismiss"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await dismissStaleNudgeAction(
                withTarget(new FormData())
              );
              if (!res.ok) {
                toast(res.error, { tone: "error" });
                return;
              }
              toast("Keeping the episode open.");
              router.refresh();
            })
          }
          className="badge cursor-pointer border border-black/10 bg-transparent text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-ink-850"
        >
          Keep open
        </button>
      </div>
    </div>
  );
}
