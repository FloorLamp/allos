"use client";

import { useState, type FormEvent } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import DateField from "@/components/DateField";
import NotesText from "@/components/NotesText";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { ResponsiveTable, Td } from "@/components/ResponsiveTable";
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

const COLLAPSED_SESSION_COUNT = 5;

function sessionFacts(session: PracticeLog, prefs: DisplayFormatPrefs): string {
  const parts = [formatDateWithYear(session.date, prefs)];
  if (session.time)
    parts.push(formatClockValue(session.time, prefs.timeFormat));
  if (session.duration_min != null) parts.push(`${session.duration_min} min`);
  return parts.join(" · ");
}

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
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const formatPrefs = useFormatPrefs();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

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
        "This removes the session from weekly progress and any linked protocol history.",
      confirmLabel: "Delete session",
      danger: true,
    });
    if (!ok) return;
    setPendingId(session.id);
    const fd = new FormData();
    fd.set("id", String(session.id));
    try {
      // The shared undoable-delete wiring (#2038): removing one session is now the same
      // offer as removing the whole practice, or a substance history row — one engine,
      // applied evenly, so the shared history table (#1491) can assume undo instead of
      // branching per domain.
      await undoable(removePracticeSession, fd, {
        deletedMessage: "Session deleted",
      });
    } catch {
      toast("Couldn't delete that session.", { tone: "error" });
    } finally {
      setPendingId(null);
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

  const visibleSessions = expanded
    ? sessions
    : sessions.slice(0, COLLAPSED_SESSION_COUNT);
  const hasMore = sessions.length > COLLAPSED_SESSION_COUNT;
  const expandLabel =
    sessions.length === totalCount
      ? `View all ${totalCount} sessions`
      : `View ${sessions.length} recent sessions`;

  return (
    <div className="mt-3" data-testid="practice-session-history">
      <ResponsiveTable className="practice-session-list w-full text-left text-sm">
        <thead>
          <tr className="border-b border-black/10 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
            <th className="th">Session</th>
            <th className="th">Notes</th>
            <th className="th w-28 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {visibleSessions.map((session) => (
            <tr
              key={session.id}
              className="border-b border-black/5 align-top last:border-0 dark:border-white/5"
              data-testid={`practice-session-${session.id}`}
            >
              {editingId === session.id ? (
                <Td slot="full" colSpan={3} className="px-2 py-2">
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
                </Td>
              ) : (
                <>
                  <Td
                    slot="title"
                    className="px-2 py-2 tabular-nums text-slate-700 dark:text-slate-200"
                  >
                    {sessionFacts(session, formatPrefs)}
                  </Td>
                  <Td
                    slot="meta"
                    empty={!session.notes}
                    className="max-w-sm px-2 py-2 text-slate-500 dark:text-slate-400"
                  >
                    {session.notes ? <NotesText notes={session.notes} /> : "—"}
                  </Td>
                  <Td slot="actions" className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      <OverflowMenu
                        label="Session actions"
                        open={menuOpenId === session.id}
                        onOpenChange={(open) =>
                          setMenuOpenId(open ? session.id : null)
                        }
                      >
                        {({ close }) => (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="practice-session-edit"
                              onClick={() => {
                                close();
                                setEditingId(session.id);
                              }}
                              className={MENU_ITEM}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="practice-session-delete"
                              disabled={pendingId === session.id}
                              onClick={() => {
                                close();
                                void remove(session);
                              }}
                              className={MENU_ITEM_DANGER}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </OverflowMenu>
                    </div>
                  </Td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      {hasMore && (
        <button
          type="button"
          className="mt-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="practice-session-toggle"
        >
          {expanded ? "Show fewer sessions" : expandLabel}
        </button>
      )}
    </div>
  );
}
