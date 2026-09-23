"use client";

import { useCallback, useEffect, useState } from "react";
import LogPracticeButton from "@/components/practices/LogPracticeButton";
import PracticeEditor from "@/components/practices/PracticeEditor";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import { deletePractice, untrackPractice } from "@/app/(app)/practice-actions";
import CreateAction, { CREATE_ACTIONS } from "@/components/CreateAction";
import {
  CatalogCreateControl,
  CatalogFormDialog,
} from "@/components/CatalogEditor";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { useOptionalDayContext } from "@/components/DayContext";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useToast } from "@/components/Toast";
import { shiftDateStr } from "@/lib/date";
import { formatWeekdayDate } from "@/lib/format-date";
import { practiceRowFacts, practiceRunningFacts } from "@/lib/practice";
import { clearLastGood } from "@/lib/offline/quick-entry-read";
import type { TrackedPractice } from "@/lib/queries/wellness";
import {
  QuickEntryRow,
  QuickEntryRowList,
} from "@/components/quick-entry/QuickEntryRowList";

// The quick-entry overlay's PRACTICE form (issue #1633): every tracked wellness
// practice, each one tap from logging today's session.
//
// The gap this closes is embarrassing rather than subtle — the Telegram bot has had
// one-tap practice logging since #1259, while the web app's fastest route to the
// wellness domain's core action was: open the drawer, find Wellness (itself
// relevance-gated), scroll to the card, tap. The sheet already promises "log from
// anywhere"; this is the row that makes that true for practices.
//
// It is a LIST, not a form. Each row mounts the SAME `LogPracticeButton` the protocol
// rows and Upcoming mount — which posts the SAME `logPractice` Server Action over the
// SAME `logPracticeSession` write core and answers from its typed `PracticeLogOutcome`.
// Nothing here logs a session itself.
//
// ── IT IS ALSO THE PRACTICE CATALOG (#5668) ─────────────────────────────────
//
// The Wellness page retired, and its practice management moved here by owner ruling
// (2026-09-09). Each row carries the #5237 catalog row's ⋯ — Edit, Stop tracking,
// Delete — and the list ends in the registered Add practice control. Both forms open in
// `CatalogFormDialog`, the app's one dialog host, over this sheet, so a person adds a
// practice, renames it or changes its weekly goal, and logs it without leaving the
// sheet. Only for the acting profile: the practice writes are acting-profile writes.
//
// ── THE ROW, AND THE THREE THINGS IT CAN SAY (#5431) ────────────────────────
//
// `label · facts · one trailing slot`, in ONE hairline frame rather than a bordered
// card per practice — the shape #5237 and #5300 are moving the dose and substance
// overlays to. Three states, and the facts column is what distinguishes them:
//
//   Red light therapy   0 of 3–5 this week            [15 min · Start] [Just finished]
//   Red light therapy   Running since 06:22 · ends ~06:37                       [End]
//   Red light therapy   1 today · 1 of 3–5 this week  [15 min · Start] [Just finished]
//
// The sheet used to mount the Wellness card's full control here — the `Today` label,
// its "No sessions yet" zero line, and the weekly badge that printed a pace over an
// empty week (#5395) — boxed, with a four-control cluster that wrapped to two lines on
// a phone. Today's count is a fact only when it is not zero.
//
// **The sheet stays open after a tap**, deliberately — unlike the dose list, which
// closes once nothing is left to confirm. A practice session is not a queue being
// drained: a morning check may log a sauna AND a meditation, multi-session days are the
// point (#797's ledger model), and the button refreshes the page behind it, so "stay
// where you were" already holds. There is no moment where the overlay can honestly say
// the user is done.
//
// ── WHY THIS LIST RE-READS THE SERVER ───────────────────────────────────────
//
// A live practice row COMPLETES ITSELF at start plus its usual duration (#5091), with
// no tap and no request. The sheet's props were gathered when it opened, so a row that
// simply sat there went on offering an End the server would answer "that session is no
// longer running" — the sheet's half of the same defect the control's client-only
// session copy was the other half of.
//
// So the list holds the rows and asks for them again: after every write the control
// makes, and on a timer to the derived end the server itself acts on. `loadQuickEntry`
// is THE READ THE MOUNT DID — the same gather, abandonment sweep included — rather than
// a second opinion assembled here.

// A second past the derived end, so the read lands after the instant the server's own
// completion compares against rather than racing it.
const RE_READ_SLACK_MS = 1_000;

export default function QuickPracticeList({
  practices,
  today,
  onDone,
  subjectProfileId,
}: {
  practices: TrackedPractice[];
  // The acting profile's today (YYYY-MM-DD) — the day the counts are counting, and
  // the day the re-log question is asked about (#2007 layer 3).
  today: string;
  // Dismisses the sheet. Used ONLY by the zero-state create branch below — the
  // logging branch deliberately stays open (see the paragraph above).
  onDone?: () => void;
  // The quick-log sheet's chosen subject (#4932), when it is not the acting profile.
  // The gather (`loadQuickEntry`) refuses the zero-state create for a non-acting
  // subject, so this is only ever passed alongside a non-empty `practices`.
  subjectProfileId?: number;
}) {
  const dayContext = useOptionalDayContext();
  const prefs = useFormatPrefs();
  const profileToday = dayContext?.today ?? today;
  const dayLabel =
    today === profileToday
      ? "Today"
      : today === shiftDateStr(profileToday, -1)
        ? "Yesterday"
        : formatWeekdayDate(today, prefs);
  const [rows, setRows] = useState(practices);
  const [creating, setCreating] = useState(false);
  // Follow the gather whenever the sheet hands down a new one — the same server-wins
  // discipline the row control keeps over its own count.
  const [gathered, setGathered] = useState(practices);
  if (gathered !== practices) {
    setGathered(practices);
    setRows(practices);
  }

  const reread = useCallback(() => {
    void loadQuickEntry(
      "practice",
      subjectProfileId,
      today,
      dayContext?.parts.reach.kind === "dated" ? "dated" : "sheet"
    ).then(
      (result) => {
        if (result.kind === "refused") {
          setRows([]);
          clearLastGood();
          return;
        }
        const data = result.data;
        if (data.form === "practice") setRows(data.practices);
      },
      // A dropped read leaves the rows exactly as they were. Nothing here is a write,
      // so there is no promise to walk back and nothing to say.
      () => {}
    );
  }, [subjectProfileId, today, dayContext?.parts.reach.kind]);

  // THE EARLIEST DERIVED END ON SCREEN. One timer for the list: whichever row completes
  // first, the re-read that follows re-derives the next.
  useEffect(() => {
    const ends = rows.flatMap((row) =>
      row.liveSession?.expectedEnd ? [row.liveSession.expectedEnd.at] : []
    );
    if (ends.length === 0) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now()) + RE_READ_SLACK_MS;
    const timer = setTimeout(reread, wait);
    return () => clearTimeout(timer);
  }, [rows, reread]);

  // ZERO STATE: the first practice is offered here (#3066). This sheet row is always
  // visible, so it is where the bootstrap belongs. It mounts the SAME PracticeEditor the
  // list's Add practice opens, over the same `savePractice` action — inline, because
  // with nothing to log there is no list for a dialog to stand over.
  //
  // UNLIKE the logging branch, this one CLOSES on success. Declaring a practice is a
  // transaction with a real end, and the sheet's props were gathered on open — so
  // staying would show the create form again over a list that has since changed.
  // Reopening "Log practice" now finds the practice, and the nav row has appeared.
  if (rows.length === 0) {
    return (
      <div className="space-y-3" data-testid="quick-entry-practice-empty">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing tracked yet. Start a practice and log it from here.
        </p>
        <PracticeEditor
          onSaved={() => onDone?.()}
          onCancel={() => onDone?.()}
        />
      </div>
    );
  }

  const manages = subjectProfileId == null;
  return (
    <div className="space-y-3">
      <QuickEntryRowList testId="quick-entry-practice-list">
        {rows.map((practice) => {
          const facts = practiceRowFacts(practice);
          return (
            <QuickEntryRow
              key={practice.identity}
              testId={`quick-entry-practice-${practice.identity}`}
              identity={practice.name}
              facts={
                <div
                  className="mt-0.5 text-sm text-slate-500 dark:text-slate-400"
                  data-testid="practice-row-facts"
                >
                  {practice.liveSession ? (
                    practiceRunningFacts(
                      practice.liveSession.startTime,
                      practice.liveSession.expectedEnd?.hhmm ?? null
                    )
                  ) : (
                    <>
                      {practice.todayCount > 0 && (
                        <span data-testid="practice-today-count">
                          {practice.todayCount}{" "}
                          {dayLabel === "Today" || dayLabel === "Yesterday"
                            ? dayLabel.toLowerCase()
                            : `on ${dayLabel}`}
                        </span>
                      )}
                      {practice.todayCount > 0 ? " · " : null}
                      {facts.week}
                    </>
                  )}
                </div>
              }
              actions={
                <>
                  <LogPracticeButton
                    practice={practice.name}
                    todayCount={practice.todayCount}
                    today={today}
                    profileToday={profileToday}
                    dayLabel={dayLabel}
                    defaultDurationMin={practice.previousDurationMin}
                    liveSession={practice.liveSession}
                    inlineDuration
                    inlineWhen
                    chipRow
                    onServerRead={reread}
                    subjectProfileId={subjectProfileId}
                  />
                  {manages && (
                    <PracticeRowMenu practice={practice} onChanged={reread} />
                  )}
                </>
              }
            />
          );
        })}
      </QuickEntryRowList>
      {manages && (
        <CreateAction
          housing="section"
          declaration={{
            kind: "practice",
            control: (
              <CatalogCreateControl onActivate={() => setCreating(true)} />
            ),
          }}
        />
      )}
      {creating && (
        <CatalogFormDialog
          Form={PracticeEditor}
          formProps={{}}
          title={CREATE_ACTIONS.practice.label}
          onClose={() => {
            setCreating(false);
            reread();
          }}
        />
      )}
    </div>
  );
}

// One row's ⋯, in the #5237 catalog row's grammar. Stop tracking keeps every logged
// session on History; Delete takes the sessions with it, under one Undo.
function PracticeRowMenu({
  practice,
  onChanged,
}: {
  practice: TrackedPractice;
  onChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const undoable = useUndoableDelete();
  const fd = () => {
    const form = new FormData();
    form.set("target_id", String(practice.targetId));
    form.set("practice", practice.name);
    return form;
  };

  async function untrack() {
    const ok = await confirm({
      title: "Stop tracking this practice?",
      message:
        "The weekly goal and its reminders will be removed. Logged sessions will stay in your history. Linked protocols will stop showing weekly progress.",
      confirmLabel: "Stop tracking",
      danger: true,
    });
    if (!ok) return;
    const result = await untrackPractice(fd()).catch(() => null);
    if (!result?.ok) {
      toast(result?.error ?? "Couldn't stop tracking that practice.", {
        tone: "error",
      });
      return;
    }
    toast("Weekly goal removed");
    onChanged();
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete practice and session history?",
      message:
        "The weekly goal and its reminders will be removed, along with every logged session. Linked protocols will remain but stop showing weekly progress. You can undo this deletion.",
      confirmLabel: "Delete practice",
      danger: true,
    });
    if (!ok) return;
    await undoable(deletePractice, fd(), {
      deletedMessage: `${practice.name} deleted.`,
    });
    onChanged();
  }

  return (
    <>
      <OverflowMenu
        itemName={practice.name}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        {({ close }) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM_DANGER}
              onClick={() => {
                close();
                void untrack();
              }}
            >
              Stop tracking
            </button>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM_DANGER}
              onClick={() => {
                close();
                void remove();
              }}
            >
              Delete practice
            </button>
          </>
        )}
      </OverflowMenu>
      {editing && (
        <CatalogFormDialog
          Form={PracticeEditor}
          formProps={{
            targetId: practice.targetId,
            name: practice.name,
            perWeek: practice.perWeek,
            perWeekMax: practice.perWeekMax,
          }}
          title={practice.name}
          onClose={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
