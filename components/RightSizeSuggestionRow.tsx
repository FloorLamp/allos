"use client";

import { useState, useTransition } from "react";
import type { RightSizeCandidate } from "@/lib/target-rightsize";
import { RIGHTSIZE_STOP_LABEL } from "@/lib/target-rightsize";
import type { FormResult } from "@/lib/types";

// ONE right-sizing suggestion row (issue #1670): the candidate's title/detail plus the
// three decisions it offers — lower the floor to the cadence actually kept, stop
// tracking (landing in the domain's own no-expectation state), or keep the target as
// it is and hide the card.
//
// A client component because both accepts can legitimately REFUSE: the cadence may
// have recovered, the target may have been re-tuned or untracked, or the suggestion
// may already have been accepted from another device since the page rendered, and each
// answers with a typed outcome. Rendering that outcome instead of assuming success is
// the inline-action rule; a bare server-action form would silently swallow "that
// suggestion is out of date" and leave the user believing their target changed.
//
// Both accepts carry the dedupeKey and NOTHING else — never the new floor. The number
// written is the one the detector is currently suggesting, read server-side.
export default function RightSizeSuggestionRow({
  candidate,
  lowerAction,
  stopAction,
  dismissAction,
}: {
  candidate: RightSizeCandidate;
  lowerAction: (formData: FormData) => Promise<FormResult>;
  stopAction: (formData: FormData) => Promise<FormResult>;
  dismissAction: (formData: FormData) => Promise<FormResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (formData: FormData) => Promise<FormResult>) {
    setError(null);
    const fd = new FormData();
    fd.set("dedupe_key", candidate.key);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setError(res.error);
    });
  }

  const stopLabel = RIGHTSIZE_STOP_LABEL[candidate.domain];
  return (
    <li
      data-testid="right-size-item"
      data-target={candidate.targetId}
      className="rounded-xl border border-black/10 bg-slate-50/60 p-3 dark:border-white/10 dark:bg-ink-850/40"
    >
      <p className="font-medium text-slate-800 dark:text-slate-100">
        {candidate.title}
      </p>
      <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
        {candidate.detail}
      </p>
      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        {candidate.evidence}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {candidate.suggestedFloor != null && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(lowerAction)}
            data-testid="right-size-lower"
            title={`Lower ${candidate.label} to ${candidate.suggestedFloor}× a week`}
            className="btn btn-sm"
          >
            Lower to {candidate.suggestedFloor}× a week
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => run(stopAction)}
          data-testid="right-size-stop"
          title={`${stopLabel} — ${candidate.label}`}
          className="btn-ghost btn-sm"
        >
          {stopLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(dismissAction)}
          data-testid="right-size-dismiss"
          title="Keep the current weekly target and hide this suggestion"
          className="btn-ghost btn-sm"
        >
          Keep as is
        </button>
      </div>
      {error && (
        <p
          data-testid="right-size-outcome"
          role="status"
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {error}
        </p>
      )}
    </li>
  );
}
