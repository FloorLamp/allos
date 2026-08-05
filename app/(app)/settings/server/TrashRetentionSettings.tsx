"use client";

import { useState } from "react";
import {
  MIN_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
} from "@/lib/retention";
import { saveTrashRetention } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// GLOBAL, admin-only: how long a deleted row stays restorable under Data → Trash
// before the hourly notify tick purges it for good (#2013). The audit-retention
// precedent one card over: instance policy a self-hoster sets on their own terms.
//
// The help text names what the window ACTUALLY holds — the deleted row's content AND
// any video clips captured with it — because raising this keeps deleted health data
// on the box for longer, and "how long trash keeps things" would hide that. The
// value is clamped server-side to [MIN, MAX] days.
export default function TrashRetentionSettings({ days }: { days: number }) {
  const [value, setValue] = useState(String(days));
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save() {
    const fd = new FormData();
    fd.set("trash_retention_days", value.trim());
    runSave(async () => {
      await saveTrashRetention(fd);
    });
  }

  return (
    <div data-testid="trash-retention-settings" className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Trash retention
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Deleted rows stay restorable under Data → Trash for this many days, then
        the hourly notify tick purges them for good. The window holds the
        deleted row’s full content <em>and</em> any video clips captured with
        it, so a longer window means deleted health data stays on this server
        longer — anyone can remove a row immediately with “Delete permanently”.
        Allowed range: {MIN_TRASH_RETENTION_DAYS}–{MAX_TRASH_RETENTION_DAYS}{" "}
        days.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="label" htmlFor="trash-retention-days">
            Keep for (days)
          </label>
          <input
            id="trash-retention-days"
            data-testid="trash-retention-days"
            type="number"
            min={MIN_TRASH_RETENTION_DAYS}
            max={MAX_TRASH_RETENTION_DAYS}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="input"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="btn"
          data-testid="trash-retention-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
