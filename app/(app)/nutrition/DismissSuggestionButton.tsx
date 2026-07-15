"use client";

import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { dismissSuggestion } from "./supplement-actions";

// Dismiss control for an AI supplement suggestion. Dismissing is permanent (the
// suggestion is marked dismissed and won't reappear), so it routes through a
// light confirm first. A plain button — not a form action — because confirm()
// opens a modal the user must answer, which would deadlock inside a form-action
// transition.
export default function DismissSuggestionButton({
  id,
  name,
}: {
  id: number;
  name: string;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function onDismiss() {
    const ok = await confirm({
      title: "Dismiss suggestion",
      message: `Dismiss “${name}”? It won't be suggested again, but you can generate new suggestions later.`,
      confirmLabel: "Dismiss",
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(id));
    setBusy(true);
    try {
      await dismissSuggestion(fd);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onDismiss}
      disabled={busy}
      className="text-slate-400 transition hover:text-slate-700 disabled:opacity-50 dark:text-slate-500 dark:hover:text-slate-200"
    >
      {busy ? "Dismissing…" : "Dismiss"}
    </button>
  );
}
