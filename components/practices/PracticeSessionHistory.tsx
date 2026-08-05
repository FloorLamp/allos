"use client";

import { useState, type FormEvent } from "react";
import { useToast } from "@/components/Toast";
import DateField from "@/components/DateField";
import NotesText from "@/components/NotesText";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import EntryHistoryTable, {
  type EntryHistoryColumn,
} from "@/components/EntryHistoryTable";
import {
  formatClockValue,
  formatDateWithYear,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import type { PracticeLog, PracticeSessionMutationOutcome } from "@/lib/types";
import {
  editPracticeSession,
  removePracticeSession,
} from "@/app/(app)/wellness/actions";

function sessionFacts(session: PracticeLog, prefs: DisplayFormatPrefs): string {
  const parts = [formatDateWithYear(session.date, prefs)];
  if (session.time)
    parts.push(formatClockValue(session.time, prefs.timeFormat));
  if (session.duration_min != null) parts.push(`${session.duration_min} min`);
  return parts.join(" · ");
}

// The practice-session history list on the shared EntryHistoryTable (#1491):
// the shell, ⋯ menu, collapsed-5 window and undoable delete live in the shared
// component; this file keeps practice's columns, its edit form, and the typed
// mutation-outcome copy.
export default function PracticeSessionHistory({
  sessions,
  totalCount = sessions.length,
  emptyText = "No sessions during this period.",
}: {
  sessions: PracticeLog[];
  totalCount?: number;
  emptyText?: string;
}) {
  const toast = useToast();
  const formatPrefs = useFormatPrefs();
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function submitEdit(
    event: FormEvent<HTMLFormElement>,
    id: number,
    done: () => void
  ) {
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
      done();
    } else if (outcome.kind === "invalid-date") {
      toast("Choose a date within 30 days of today.", { tone: "error" });
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

  const expandLabel =
    sessions.length === totalCount
      ? `View all ${totalCount} sessions`
      : `View ${sessions.length} recent sessions`;

  const columns: EntryHistoryColumn<PracticeLog>[] = [
    {
      header: "Session",
      slot: "title",
      cellClassName: "tabular-nums text-slate-700 dark:text-slate-200",
      cell: (session) => sessionFacts(session, formatPrefs),
    },
    {
      header: "Notes",
      slot: "meta",
      empty: (session) => !session.notes,
      cellClassName: "max-w-sm text-slate-500 dark:text-slate-400",
      cell: (session) =>
        session.notes ? <NotesText notes={session.notes} /> : "—",
    },
  ];

  return (
    <div className="mt-3" data-testid="practice-session-history">
      <EntryHistoryTable
        items={sessions}
        columns={columns}
        tableClassName="practice-session-list w-full text-left text-sm"
        actionsHeaderClassName="w-28"
        expandToggle={{
          collapsedLabel: expandLabel,
          expandedLabel: "Show fewer sessions",
          testId: "practice-session-toggle",
        }}
        menuLabel="Session actions"
        rowTestId={(session) => `practice-session-${session.id}`}
        editTestId={() => "practice-session-edit"}
        deleteTestId={() => "practice-session-delete"}
        renderEditForm={(session, done) => (
          <form
            onSubmit={(event) => submitEdit(event, session.id, done)}
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
              <button type="button" className="btn-ghost" onClick={done}>
                Cancel
              </button>
            </div>
          </form>
        )}
        confirmDelete={() => ({
          title: "Delete practice session?",
          message:
            "This removes the session from weekly progress and any linked protocol history.",
          confirmLabel: "Delete session",
        })}
        deleteFormData={(session) => {
          const fd = new FormData();
          fd.set("id", String(session.id));
          return fd;
        }}
        // The shared undoable-delete wiring (#2038): removing one session is the
        // same offer as removing a substance history row — one engine, applied
        // evenly, which is what lets this table assume undo instead of
        // branching per domain.
        deleteAction={removePracticeSession}
        deletedMessage="Session deleted"
        onDeleteError={() =>
          toast("Couldn't delete that session.", { tone: "error" })
        }
      />
    </div>
  );
}
