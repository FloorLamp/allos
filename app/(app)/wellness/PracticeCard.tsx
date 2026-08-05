"use client";

import { useState } from "react";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import PracticeCardHeader from "@/components/practices/PracticeCardHeader";
import PracticeHeatmap from "@/components/practices/PracticeHeatmap";
import PracticeHistorySection from "@/components/practices/PracticeHistorySection";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import type { PracticeLog } from "@/lib/types";
import type { WellnessPractice } from "@/lib/queries/wellness";
import PracticeEditor from "./PracticeEditor";
import { deletePractice, untrackPractice } from "./actions";

export default function PracticeCard({
  practice,
  sessions,
  today,
}: {
  practice: WellnessPractice;
  sessions: PracticeLog[];
  today: string;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [untracking, setUntracking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const undoable = useUndoableDelete();
  const todaySessions = sessions.filter((session) => session.date === today);

  async function untrack() {
    if (practice.targetId == null) return;
    const ok = await confirm({
      title: "Stop tracking this practice?",
      message:
        "The weekly goal and its reminders will be removed. Logged sessions will stay in your history. Linked protocols will stop showing weekly progress.",
      confirmLabel: "Stop tracking",
      danger: true,
    });
    if (!ok) return;
    setUntracking(true);
    const fd = new FormData();
    fd.set("target_id", String(practice.targetId));
    try {
      const result = await untrackPractice(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      setEditing(false);
      toast("Weekly goal removed");
    } catch {
      toast("Couldn't stop tracking that practice.", { tone: "error" });
    } finally {
      setUntracking(false);
    }
  }

  async function deleteWithHistory() {
    if (practice.sessionCount === 0) return;
    const sessionLabel =
      practice.sessionCount === 1
        ? "1 logged session"
        : `${practice.sessionCount} logged sessions`;
    const ok = await confirm({
      title: "Delete practice and session history?",
      message: `${
        practice.targetId == null
          ? ""
          : "The weekly goal and its reminders will be removed. Linked protocols will remain but stop showing weekly progress. "
      }This will also delete ${sessionLabel}. You can undo this deletion.`,
      confirmLabel: "Delete practice",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    const fd = new FormData();
    if (practice.targetId != null)
      fd.set("target_id", String(practice.targetId));
    fd.set("practice", practice.name);
    try {
      await undoable(deletePractice, fd, {
        deletedMessage: `Practice and ${sessionLabel} deleted.`,
      });
      setEditing(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article
      className={`card relative space-y-4 ${editing ? "z-10" : ""}`}
      data-testid="wellness-practice-card"
    >
      <PracticeCardHeader
        name={practice.name}
        progress={
          practice.perWeek == null
            ? undefined
            : {
                count: practice.countThisWeek,
                perWeek: practice.perWeek,
                perWeekMax: practice.perWeekMax,
                pace: practice.pace,
                atCeiling: practice.atCeiling,
                testId: "wellness-practice-progress",
              }
        }
        subtitle={practice.perWeek == null ? "Session history only" : undefined}
        action={
          <div data-testid="wellness-practice-actions">
            <OverflowMenu
              label={`${practice.name} actions`}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      close();
                      setEditing(true);
                    }}
                    className={MENU_ITEM}
                    data-testid="wellness-practice-edit"
                  >
                    {practice.targetId == null ? "Set target" : "Edit"}
                  </button>
                  {practice.targetId != null && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close();
                        void untrack();
                      }}
                      disabled={untracking}
                      className={MENU_ITEM_DANGER}
                      data-testid="wellness-practice-untrack"
                    >
                      {untracking ? "Removing…" : "Stop tracking"}
                    </button>
                  )}
                  {practice.sessionCount > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        close();
                        void deleteWithHistory();
                      }}
                      disabled={deleting}
                      className={MENU_ITEM_DANGER}
                      data-testid="wellness-practice-delete"
                    >
                      {deleting ? "Deleting…" : "Delete practice"}
                    </button>
                  )}
                </>
              )}
            </OverflowMenu>
          </div>
        }
      />

      {editing && (
        <PracticeEditor
          compact
          targetId={practice.targetId}
          name={practice.name}
          perWeek={practice.perWeek ?? 3}
          perWeekMax={practice.perWeekMax}
          onDone={() => setEditing(false)}
        />
      )}

      <PracticeHeatmap
        data={practice.heatmap}
        label={`${practice.name} activity`}
      />

      <LogPracticeButton
        practice={practice.name}
        todayCount={todaySessions.length}
        // The latest time today's sessions carry, so the re-log question can name it
        // ("You logged Sauna today at 08:12"). A bare one-tap session records no
        // time, and then the question simply doesn't claim one.
        lastLoggedTime={
          todaySessions
            .map((session) => session.time)
            .filter((time): time is string => time != null)
            .sort()
            .at(-1) ?? null
        }
        atCeiling={practice.atCeiling}
        today={today}
        defaultDurationMin={practice.previousDurationMin}
        showDetails
      />

      <PracticeHistorySection
        title="Session history"
        sessions={sessions}
        sessionCount={practice.sessionCount}
        lastUsed={practice.lastUsed}
        today={today}
        emptyText="No sessions logged yet."
        usageTestId="wellness-practice-usage"
      />
    </article>
  );
}
