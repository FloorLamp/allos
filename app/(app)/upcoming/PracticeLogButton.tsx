"use client";

import { useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { logUpcomingPractice } from "./actions";

export default function PracticeLogButton({
  targetId,
  profileId,
}: {
  targetId: number;
  profileId: number;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function log() {
    setPending(true);
    const fd = new FormData();
    fd.set("target_id", String(targetId));
    fd.set("profile_id", String(profileId));
    try {
      const result = await logUpcomingPractice(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
      } else if (result.outcome.kind === "logged") {
        toast(
          result.outcome.count === 1
            ? "Logged today's session"
            : `Logged — ${result.outcome.count} sessions today`
        );
      } else {
        toast("That practice is no longer available.", { tone: "error" });
      }
    } catch {
      toast("Couldn't log that session. Try again.", { tone: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={log}
      disabled={pending}
      data-testid="upcoming-practice-log"
      className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
    >
      <IconCheck className="h-3.5 w-3.5" stroke={1.75} />
      {pending ? "Logging…" : "Log session"}
    </button>
  );
}
