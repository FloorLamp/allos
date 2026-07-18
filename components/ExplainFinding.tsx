"use client";

import { useState, useTransition } from "react";
import { IconHelpCircle } from "@tabler/icons-react";
import type { Reason } from "@/lib/reasons";
import { explainFindingAction } from "@/app/(app)/upcoming/actions";
import NotesText from "@/components/NotesText";

// "Why is this flagged?" affordance (issue #878, Phase 1). A small button that, on
// demand, narrates a finding's OWN reason payload via the Light tier — or, keyless,
// shows the deterministic structured reasons. Nothing is computed here; the reasons
// are the server-rendered item's own, echoed back to the narration action.
export default function ExplainFinding({
  title,
  detail,
  reasons,
}: {
  title: string;
  detail?: string | null;
  reasons: Reason[];
}) {
  const [pending, start] = useTransition();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function explain() {
    if (text != null) {
      setOpen((o) => !o);
      return;
    }
    start(async () => {
      const fd = new FormData();
      fd.set("title", title);
      if (detail) fd.set("detail", detail);
      fd.set("reasons", JSON.stringify(reasons));
      const res = await explainFindingAction(fd);
      if (res.ok) {
        setText(res.text);
        setOpen(true);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="shrink-0" data-testid="explain-finding">
      <button
        type="button"
        onClick={explain}
        disabled={pending}
        data-testid="explain-finding-button"
        aria-expanded={open}
        title="Why is this flagged?"
        className="flex items-center gap-1 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
      >
        <IconHelpCircle className="h-3.5 w-3.5" stroke={1.75} />
        {pending ? "…" : "Why?"}
      </button>
      {open && text != null && (
        <NotesText
          notes={text}
          as="div"
          data-testid="explain-finding-text"
          className="mt-1 max-w-xs rounded-lg border border-black/10 bg-slate-50 p-2 text-xs text-slate-600 dark:border-white/10 dark:bg-ink-850 dark:text-slate-300"
        />
      )}
      {error && (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
