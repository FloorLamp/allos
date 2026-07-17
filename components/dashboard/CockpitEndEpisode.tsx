"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconMoodCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { endEpisodeAction } from "@/app/(app)/medical/episodes/actions";

// "Feeling better" — end an illness episode from its hero cockpit (issue #858, reusing
// the #856 endEpisodeAction). Carries the episode id AND, for a household member's
// cockpit, the target profileId so the action gates on THAT profile
// (requireProfileWriteAccess) and closes their episode without switching the acting
// profile. On the acting profile's own cockpit profileId is omitted (the active-profile
// requireWriteAccess path). Answers from the action's typed outcome — never an
// unconditional confirm.
export default function CockpitEndEpisode({
  episodeId,
  profileId,
}: {
  episodeId: number;
  profileId?: number;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <button
      type="button"
      data-testid="cockpit-end-episode"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("episodeId", String(episodeId));
          if (profileId != null) fd.set("profileId", String(profileId));
          const res = await endEpisodeAction(fd);
          if (!res.ok) {
            toast(res.error, { tone: "error" });
            return;
          }
          toast("Marked feeling better.");
          router.refresh();
        })
      }
      className="badge cursor-pointer border border-black/10 bg-transparent text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-ink-850"
    >
      <IconMoodCheck className="mr-1 inline h-3.5 w-3.5" stroke={1.75} />
      {pending ? "Ending…" : "Feeling better"}
    </button>
  );
}
