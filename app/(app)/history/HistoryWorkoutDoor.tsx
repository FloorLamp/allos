"use client";

import Button from "@/components/Button";
import { useActivityEditor } from "@/components/ActivityEditorProvider";

// THE WORKOUTS DOOR IN THE RECORD'S ADD ROW (#4950 item 5).
//
// The training log keeps its own editor — `docs/internals/history.md` §"The training
// hub keeps its own log" is about the RECORD, and it stands. So this is a door to that
// editor, not a tenth kind: it calls the shared `openCreate` with the day being read
// and the window the chart is showing, and nothing else about the training log moves.
//
// NO ACTIVITY-TYPE GUESS. Heart rate cannot tell a run from a sauna and this app has no
// minute-grain movement stream, so the call carries clocks and a day and never a `type`.
//
// ITS OWN COMPONENT, so the add row does not take a dependency on the activity editor
// for the eight kinds that do not need one — the row renders this only on the day view,
// and only there is the editor's context consulted at all.
//
// A PROFILE THAT DOES NOT TRAIN SEES NOTHING. `trainingRelevant` is the same gate every
// other workout affordance reads; a door onto an editor that would refuse to open is
// worse than no door.
export default function HistoryWorkoutDoor({
  date,
  window,
}: {
  /** The day the reader is looking at — what the editor's create form opens on. */
  date: string;
  /** The window the chart is showing, as the `HH:MM` params the chips carry. */
  window: { from: string; to?: string } | null;
}) {
  const { openCreate, trainingRelevant } = useActivityEditor();
  if (!trainingRelevant) return null;
  return (
    <span className="shrink-0">
      {/* A NEW CONTROL, so it is `Button` and not the row's raw classes: #4978 owns
          `btn-ghost btn-sm` and is converting this page's neighbours. The row reads
          mixed until that lands, which is the migration's own shape and not a choice
          made here. */}
      <Button
        data-testid="history-add-workout"
        onClick={() =>
          openCreate({
            date,
            startTime: window?.from,
            endTime: window?.to,
          })
        }
      >
        Workouts
      </Button>
    </span>
  );
}
