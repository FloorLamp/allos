"use client";

import { useState, useTransition } from "react";
import {
  digestTimeSuggestionCopy,
  DIGEST_TIME_STALE_TEXT,
  type DigestTimeSuggestion,
} from "@/lib/digest-time-suggestion";
import { formatNotifyTime } from "@/lib/notifications/schedule";
import {
  applyDigestTimeSuggestion,
  switchDigestToDynamic,
  dismissDigestTimeSuggestion,
} from "../profile/actions";

// The digest time suggestion's PRIMARY surface (#2217): beside the digest time, where
// the setting is, so the fix is one tap from the fact. A rendered aggregate on a page
// the user opened — class 2 in the attention doctrine, no consent question.
//
// It states the measured facts and nothing about the person (#992/#716): two clock
// times, what follows from them, and what they were measured over. No "you should", no
// streak, no judgement — and no adjective anywhere, which is why it renders as calm
// body text rather than as a warning banner.
//
// THREE EXITS, ALL EXPLICIT. Use the proposed time, switch to the mode that waits for
// the data instead, or decline. Declining is FIRST CLASS: it dismisses the episode, not
// today's rendering, and the same key silences the digest's own line (constraint 5).
//
// Nothing here carries the proposed minute into the write. Each action re-resolves the
// live suggestion server-side, so a tab left open across a week of drifting statistics
// can only ever write what the detector currently proposes — or refuse and say so.
export default function DigestTimeSuggestionRow({
  suggestion,
  onApplied,
}: {
  suggestion: DigestTimeSuggestion;
  // Fold an accepted write into the form's local field bag, so the time input beside
  // this row shows what was just stored instead of drifting from it. It does NOT
  // re-save: the action already wrote, and posting the whole schedule back would be a
  // second write the user never asked for.
  onApplied: (patch: Record<string, string>) => void;
}) {
  const copy = digestTimeSuggestionCopy(suggestion);
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);

  function run(
    action: () => Promise<{ ok: boolean }>,
    applied: Record<string, string>
  ) {
    setRefusal(null);
    start(async () => {
      const result = await action();
      if (result.ok) onApplied(applied);
      else setRefusal(DIGEST_TIME_STALE_TEXT);
    });
  }

  return (
    <div
      className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50"
      data-testid="digest-time-suggestion"
    >
      <p className="text-sm text-slate-700 dark:text-slate-200">
        {copy.headline} {copy.detail}
      </p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {copy.evidence}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          data-testid="digest-time-use"
          onClick={() =>
            run(applyDigestTimeSuggestion, {
              digest_hour: formatNotifyTime(suggestion.proposedMinute),
            })
          }
        >
          {copy.useLabel}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={pending}
          data-testid="digest-time-dynamic"
          onClick={() => run(switchDigestToDynamic, { digest_mode: "dynamic" })}
        >
          {copy.dynamicLabel}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={pending}
          data-testid="digest-time-dismiss"
          onClick={() => run(dismissDigestTimeSuggestion, {})}
        >
          {copy.dismissLabel}
        </button>
      </div>
      {refusal && (
        <p
          className="mt-2 text-xs text-slate-600 dark:text-slate-300"
          data-testid="digest-time-refusal"
        >
          {refusal}
        </p>
      )}
    </div>
  );
}
