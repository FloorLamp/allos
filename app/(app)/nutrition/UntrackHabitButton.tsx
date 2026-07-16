"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconX } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { untrackFoodHabit } from "./actions";

// The Weekly-habits "stop tracking" (X) control (#748 item 6). Untracking nulls any
// protocol's frequency_target_id link (the row-ops side-state rule) — so a protocol that
// adopted this habit as its intervention (#580) would silently lose its measurement in
// one tap. When `protocolName` is set we confirm first; an unreferenced habit removes
// with no prompt, exactly as before. A failed write surfaces a toast instead of the old
// bare server-action form, which silently no-op'd on error.
export default function UntrackHabitButton({
  targetId,
  protocolName,
}: {
  targetId: number;
  // The protocol that measures this habit, or null/undefined when none — the confirm
  // gate only fires when a protocol would lose its measurement.
  protocolName?: string | null;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function onClick() {
    if (protocolName) {
      const ok = await confirm({
        title: "Stop tracking this habit?",
        message: `This habit measures your “${protocolName}” protocol — stop tracking anyway? The protocol will lose its measurement.`,
        confirmLabel: "Stop tracking",
        cancelLabel: "Keep tracking",
        danger: true,
      });
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("target_id", String(targetId));
    const res = await untrackFoodHabit(fd);
    if (!res.ok) {
      toast(res.error || "Couldn't stop tracking that habit.", {
        tone: "error",
      });
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label="Stop tracking this habit"
      className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-ink-800"
    >
      <IconX className="h-4 w-4" stroke={2} />
    </button>
  );
}
