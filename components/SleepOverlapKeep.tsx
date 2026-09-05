"use client";

import Button from "@/components/Button";
import SyncTimestamp from "@/components/integrations/SyncTimestamp";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import { keepSleepSession } from "@/app/(app)/data/review-actions";
import type { OverlappingSleepPair } from "@/lib/queries/sleep";

// KEEP THIS ONE, on a night stored twice (#5021, deferred from #3628's decision 5).
//
// Review could already SEE the pair and could only tell the person to go to Manage data
// and delete the wrong one — a correct instruction that sends them away from the page
// that found the problem to find the row again themselves. The decision is theirs
// either way; what changes is that they can make it here.
//
// It is the ORDINARY delete underneath — the shared undoable-delete wiring, the same
// toast, the same "Undo" — because keeping one row IS deleting the other, and the pair
// stops being listed for the reason it was ever listed: one of the two rows is gone.
export default function SleepOverlapKeep({
  pair,
}: {
  pair: OverlappingSleepPair;
}) {
  const undoable = useUndoableDelete();

  return (
    <ul className="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-200">
      {pair.sessions.map((session, index) => {
        const other = pair.sessions[index === 0 ? 1 : 0];
        return (
          <li
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              <SyncTimestamp value={session.started_at} /> · {session.minutes}{" "}
              min
            </span>
            <Button
              data-testid={`sleep-overlap-keep-${session.id}`}
              onClick={() => {
                const fd = new FormData();
                fd.set("keep_id", String(session.id));
                fd.set("drop_id", String(other.id));
                void undoable(keepSleepSession, fd, {
                  deletedMessage: "Kept one night; the other was deleted.",
                });
              }}
            >
              Keep this one
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
