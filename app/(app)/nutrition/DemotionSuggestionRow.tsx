"use client";

import { useState, useTransition } from "react";
import type { Finding } from "@/lib/findings";
import type { FormResult } from "@/lib/types";

// ONE demotion-suggestion row (issue #1505 part 2): the finding's title/detail plus
// the two decisions it offers — accept (which WRITES `obligation = may`, the user's own
// declared change) and dismiss (which only silences the card through the shared bus).
//
// A client component because the accept can legitimately REFUSE: the item may have
// been paused, deleted, or already demoted from another device since the page
// rendered, and the write core answers with a typed outcome for each. Rendering that
// outcome instead of assuming success is the inline-action rule; a server-action form
// with no feedback would silently swallow "that item is paused" and leave the user
// believing the obligation changed.
export default function DemotionSuggestionRow({
  finding,
  acceptAction,
  dismissAction,
}: {
  finding: Finding;
  acceptAction: (formData: FormData) => Promise<FormResult>;
  dismissAction: (formData: FormData) => Promise<FormResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: (formData: FormData) => Promise<FormResult>) {
    setError(null);
    const fd = new FormData();
    fd.set("dedupe_key", finding.dedupeKey);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <li
      data-testid="demotion-suggestion-item"
      className="rounded-xl border border-black/10 bg-slate-50/60 p-3 dark:border-white/10 dark:bg-ink-850/40"
    >
      <p className="font-medium text-slate-800 dark:text-slate-100">
        {finding.title}
      </p>
      {finding.detail && (
        <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
          {finding.detail}
        </p>
      )}
      {finding.evidence && (
        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          {finding.evidence}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(acceptAction)}
          data-testid="demotion-accept"
          title={`Move ${finding.title} to May`}
          className="btn btn-sm"
        >
          Move to May
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(dismissAction)}
          data-testid="demotion-dismiss"
          title="Keep the current obligation and hide this suggestion"
          className="btn-ghost btn-sm"
        >
          Keep as is
        </button>
      </div>
      {error && (
        <p
          data-testid="demotion-outcome"
          role="status"
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {error}
        </p>
      )}
    </li>
  );
}
