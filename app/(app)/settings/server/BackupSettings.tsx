"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BackupSettings } from "@/lib/settings";
import { saveBackupSettings, backupNow } from "../actions";
import SaveStatus from "@/components/SaveStatus";

// GLOBAL, admin-only: automated nightly SQLite snapshots + retention (#131). The
// hour is in the instance timezone (backups are instance-wide, not per-profile).
export default function BackupSettings({
  settings,
  lastBackup,
  lastError,
}: {
  settings: BackupSettings;
  lastBackup: { name: string; size: string; when: string } | null;
  lastError: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [hour, setHour] = useState(settings.hour);
  const [keepDaily, setKeepDaily] = useState(settings.keepDaily);
  const [keepWeekly, setKeepWeekly] = useState(settings.keepWeekly);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  function save() {
    const fd = new FormData();
    fd.set("backup_enabled", enabled ? "1" : "0");
    fd.set("backup_hour", String(hour));
    fd.set("backup_keep_daily", String(keepDaily));
    fd.set("backup_keep_weekly", String(keepWeekly));
    startTransition(async () => {
      await saveBackupSettings(fd);
      setSavedAt(Date.now());
      setResult(null);
      router.refresh();
    });
  }

  function runNow() {
    startTransition(async () => {
      setResult(await backupNow());
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Automated backups
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <p className="text-xs text-slate-400 dark:text-slate-500">
        A nightly compact snapshot of the database (
        <code>data/backups/allos-*.db</code>) is taken by the hourly notify tick
        at the hour below (instance timezone), then old snapshots are pruned to
        the retention below. Snapshots stay under <code>DATA_DIR</code> and are
        never served over the web.
      </p>

      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
        />
        Enable nightly backups
      </label>

      {enabled && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Hour</label>
            <select
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              className="input"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Keep dailies</label>
            <input
              type="number"
              min={0}
              value={keepDaily}
              onChange={(e) => setKeepDaily(Number(e.target.value))}
              className="input"
            />
          </div>
          <div>
            <label className="label">Keep weeklies</label>
            <input
              type="number"
              min={0}
              value={keepWeekly}
              onChange={(e) => setKeepWeekly(Number(e.target.value))}
              className="input"
            />
          </div>
        </div>
      )}

      <p className="text-xs text-amber-600 dark:text-amber-400">
        Note: uploaded medical files live on disk under{" "}
        <code>data/uploads/</code>, not in the database — this snapshot does not
        include them. Back up the whole <code>DATA_DIR</code> (DB + uploads) for
        a complete restore. To restore the database: stop the container, replace{" "}
        <code>data/allos.db</code> with a snapshot, and start it again.
      </p>

      <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
        {lastBackup ? (
          <>
            Last backup: <span className="font-mono">{lastBackup.name}</span> (
            {lastBackup.size}) — {lastBackup.when}
          </>
        ) : (
          <>No backups yet.</>
        )}
        {lastError && (
          <div className="mt-1 text-rose-600 dark:text-rose-400">
            Last error: {lastError}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={pending} className="btn">
          Save
        </button>
        <button
          type="button"
          onClick={runNow}
          disabled={pending}
          className="btn-ghost"
        >
          Back up now
        </button>
      </div>

      {result && (
        <p
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
