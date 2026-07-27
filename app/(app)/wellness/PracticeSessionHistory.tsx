"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import DateField from "@/components/DateField";
import type { PracticeLog, PracticeSessionMutationOutcome } from "@/lib/types";
import { editPracticeSession, removePracticeSession } from "./actions";

function sessionFacts(session: PracticeLog): string {
  const parts = [session.date];
  if (session.time) parts.push(session.time);
  if (session.duration_min != null) parts.push(`${session.duration_min} min`);
  return parts.join(" · ");
}

export default function PracticeSessionHistory({
  sessions,
  emptyText = "No sessions in this window.",
}: {
  sessions: PracticeLog[];
  emptyText?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function submitEdit(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    setPendingId(id);
    const fd = new FormData(event.currentTarget);
    fd.set("id", String(id));
    let outcome: PracticeSessionMutationOutcome;
    try {
      outcome = await editPracticeSession(fd);
    } catch {
      toast("Couldn't update that session.", { tone: "error" });
      setPendingId(null);
      return;
    }
    setPendingId(null);
    if (outcome.kind === "updated") {
      toast("Session updated");
      setEditingId(null);
      router.refresh();
    } else if (outcome.kind === "invalid-date") {
      toast("Choose a date within 30 days of today.", { tone: "error" });
    } else {
      toast("Couldn't find that session.", { tone: "error" });
    }
  }

  async function remove(session: PracticeLog) {
    const ok = await confirm({
      title: "Delete practice session?",
      message:
        "This correction changes the practice's past adherence and protocol usage.",
      confirmLabel: "Delete session",
      danger: true,
    });
    if (!ok) return;
    setPendingId(session.id);
    const fd = new FormData();
    fd.set("id", String(session.id));
    let outcome: PracticeSessionMutationOutcome;
    try {
      outcome = await removePracticeSession(fd);
    } catch {
      toast("Couldn't delete that session.", { tone: "error" });
      setPendingId(null);
      return;
    }
    setPendingId(null);
    if (outcome.kind === "deleted") {
      toast("Session deleted");
      router.refresh();
    } else {
      toast("Couldn't find that session.", { tone: "error" });
    }
  }

  if (sessions.length === 0) {
    return (
      <p
        className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        data-testid="practice-session-empty"
      >
        {emptyText}
      </p>
    );
  }

  return (
    <div
      className="mt-3 overflow-x-auto"
      data-testid="practice-session-history"
    >
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead>
          <tr className="border-b border-black/10 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
            <th className="px-2 py-1.5 font-medium">Session</th>
            <th className="px-2 py-1.5 font-medium">Notes</th>
            <th className="w-28 px-2 py-1.5 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr
              key={session.id}
              className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
              data-testid={`practice-session-${session.id}`}
            >
              {editingId === session.id ? (
                <td colSpan={3} className="px-2 py-2">
                  <form
                    onSubmit={(event) => submitEdit(event, session.id)}
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    <label className="text-xs text-slate-500 dark:text-slate-400">
                      Date
                      <DateField
                        name="date"
                        defaultValue={session.date}
                        required
                        inputClassName="mt-1 w-full"
                      />
                    </label>
                    <label className="text-xs text-slate-500 dark:text-slate-400">
                      Time
                      <input
                        type="time"
                        name="time"
                        defaultValue={session.time ?? ""}
                        className="input mt-1 w-full"
                      />
                    </label>
                    <label className="text-xs text-slate-500 dark:text-slate-400">
                      Duration (minutes)
                      <input
                        type="number"
                        name="duration_min"
                        min="1"
                        step="1"
                        defaultValue={session.duration_min ?? ""}
                        className="input mt-1 w-full"
                      />
                    </label>
                    <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
                      Notes
                      <textarea
                        name="notes"
                        rows={2}
                        defaultValue={session.notes ?? ""}
                        className="input mt-1 w-full"
                      />
                    </label>
                    <div className="flex gap-2 sm:col-span-2">
                      <button
                        type="submit"
                        className="btn"
                        disabled={pendingId === session.id}
                        data-testid="practice-session-save"
                      >
                        {pendingId === session.id ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </td>
              ) : (
                <>
                  <td className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-200">
                    {sessionFacts(session)}
                  </td>
                  <td className="max-w-sm px-2 py-2 text-slate-500 dark:text-slate-400">
                    {session.notes || "—"}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        aria-label="Edit session"
                        data-testid="practice-session-edit"
                        onClick={() => setEditingId(session.id)}
                        className="btn-ghost p-2"
                      >
                        <IconPencil className="h-4 w-4" stroke={1.75} />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete session"
                        data-testid="practice-session-delete"
                        disabled={pendingId === session.id}
                        onClick={() => remove(session)}
                        className="btn-ghost p-2 text-rose-600 dark:text-rose-400"
                      >
                        <IconTrash className="h-4 w-4" stroke={1.75} />
                      </button>
                    </div>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
