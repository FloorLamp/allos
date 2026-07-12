"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BackupSettings } from "@/lib/settings";
import { saveBackupSettings, backupNow } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// GLOBAL, admin-only: automated nightly SQLite snapshots + retention (#131). The
// hour is in the instance timezone (backups are instance-wide, not per-profile).
export default function BackupSettings({
  settings,
  lastBackup,
  lastError,
  offsite,
}: {
  settings: BackupSettings;
  lastBackup: { name: string; size: string; when: string } | null;
  lastError: string | null;
  // Off-volume replication status (#130): whether BACKUP_DEST_DIR is configured
  // (env-driven, not editable here) plus the last off-volume copy time / error.
  offsite: {
    configured: boolean;
    lastAt: string | null;
    lastError: string | null;
  };
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [hour, setHour] = useState(settings.hour);
  const [keepDaily, setKeepDaily] = useState(settings.keepDaily);
  const [keepWeekly, setKeepWeekly] = useState(settings.keepWeekly);
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  // "Back up now" is a distinct action with its own result message, not tied to
  // the "saved" chip — keep its own transition so it doesn't flip savedAt.
  const [runningNow, startRunNow] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const busy = pending || runningNow;

  function save() {
    const fd = new FormData();
    fd.set("backup_enabled", enabled ? "1" : "0");
    fd.set("backup_hour", String(hour));
    fd.set("backup_keep_daily", String(keepDaily));
    fd.set("backup_keep_weekly", String(keepWeekly));
    runSave(async () => {
      await saveBackupSettings(fd);
      setResult(null);
      router.refresh();
    });
  }

  function runNow() {
    startRunNow(async () => {
      try {
        setResult(await backupNow());
      } catch {
        setResult({
          ok: false,
          message: "Couldn’t run the backup. Please try again.",
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Automated backups
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
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
        Snapshots land under <code>DATA_DIR</code> — the <em>same</em> volume as
        the live database — so a disk/volume loss takes the database and every
        snapshot together, and uploaded medical files (
        <code>data/uploads/</code>) aren&apos;t in a snapshot at all. Set{" "}
        <code>BACKUP_DEST_DIR</code> to a{" "}
        <strong>second mounted directory</strong> (a NAS, another disk, a synced
        folder) to copy each verified snapshot off-volume and mirror uploads
        there — see the README &ldquo;Backups&rdquo; section.
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

      <div
        data-testid="backup-offsite"
        className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400"
      >
        <span className="font-medium text-slate-600 dark:text-slate-300">
          Off-volume copy:
        </span>{" "}
        {offsite.configured ? (
          <>
            enabled (<code>BACKUP_DEST_DIR</code>).{" "}
            {offsite.lastAt ? (
              <>Last off-volume backup: {offsite.lastAt}.</>
            ) : (
              <>No off-volume backup yet.</>
            )}
          </>
        ) : (
          <>
            not configured — set <code>BACKUP_DEST_DIR</code> to a second mount
            so backups survive loss of the primary volume.
          </>
        )}
        {offsite.lastError && (
          <div className="mt-1 text-rose-600 dark:text-rose-400">
            Last off-volume error: {offsite.lastError}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy} className="btn">
          Save
        </button>
        <button
          type="button"
          onClick={runNow}
          disabled={busy}
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
