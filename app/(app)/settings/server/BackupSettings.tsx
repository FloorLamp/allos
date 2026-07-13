"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BackupSettings } from "@/lib/settings";
import {
  saveBackupSettings,
  backupNow,
  verifyOffsiteDestination,
  recheckLiveIntegrity,
} from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// GLOBAL, admin-only: automated nightly SQLite snapshots + retention (#131). The
// hour is in the instance timezone (backups are instance-wide, not per-profile).
export default function BackupSettings({
  settings,
  lastBackup,
  lastError,
  integrity,
  offsite,
}: {
  settings: BackupSettings;
  lastBackup: {
    name: string;
    size: string;
    when: string;
    failed: boolean;
  } | null;
  lastError: string | null;
  // Weekly live-DB integrity verdict (#621): ok === false is the state that drives
  // `/api/health` to 503; the "Recheck integrity now" button re-tests it so a DB
  // repaired outside a snapshot restore can clear the failure without waiting a week.
  integrity: {
    ok: boolean | null;
    at: string | null;
    detail: string | null;
  };
  // Off-volume replication status (#130): whether BACKUP_DEST_DIR is configured
  // (env-driven, not editable here) plus whether it's presently mounted/verified
  // (#463) and the last off-volume copy time / error.
  offsite: {
    configured: boolean;
    ready: boolean;
    notReadyReason: string | null;
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

  function verifyOffsite() {
    startRunNow(async () => {
      setResult(await verifyOffsiteDestination());
      router.refresh();
    });
  }

  function recheckIntegrity() {
    startRunNow(async () => {
      try {
        setResult(await recheckLiveIntegrity());
      } catch {
        setResult({
          ok: false,
          message: "Couldn’t re-check integrity. Please try again.",
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
            Last snapshot file:{" "}
            <span className="font-mono">{lastBackup.name}</span> (
            {lastBackup.size}) — {lastBackup.when}
            {lastBackup.failed && (
              <span className="ml-1 font-medium text-rose-600 dark:text-rose-400">
                — integrity check FAILED (kept for forensics; not a valid
                backup)
              </span>
            )}
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
        data-testid="backup-integrity"
        className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400"
      >
        <span className="font-medium text-slate-600 dark:text-slate-300">
          Live database integrity:
        </span>{" "}
        {integrity.ok === null ? (
          <>not checked yet (runs weekly from the notify tick).</>
        ) : integrity.ok ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            OK{integrity.at ? ` — last checked ${integrity.at}` : ""}.
          </span>
        ) : (
          <>
            <span className="font-medium text-rose-600 dark:text-rose-400">
              FAILED{integrity.at ? ` — last checked ${integrity.at}` : ""}.
            </span>
            <div className="mt-1 text-rose-600 dark:text-rose-400">
              The health endpoint is reporting <code>integrity-failed</code>.
              After repairing or restoring the database, click{" "}
              <strong>Recheck integrity now</strong> to re-test and clear the
              alarm without waiting for the next weekly check.
            </div>
            {integrity.detail && (
              <div className="mt-1 font-mono text-rose-600 dark:text-rose-400">
                {integrity.detail}
              </div>
            )}
          </>
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
            {offsite.ready ? (
              <div className="mt-1 text-emerald-600 dark:text-emerald-400">
                Destination mounted and verified.
              </div>
            ) : (
              <div className="mt-1 text-amber-600 dark:text-amber-400">
                Destination not verified —{" "}
                {offsite.notReadyReason ?? "the second mount may be missing"}.
                Replication is skipped until you verify it (mount the volume,
                then click <strong>Verify destination</strong> below).
              </div>
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
        <button
          type="button"
          onClick={recheckIntegrity}
          disabled={busy}
          className="btn-ghost"
          data-testid="backup-recheck-integrity"
        >
          Recheck integrity now
        </button>
        {offsite.configured && (
          <button
            type="button"
            onClick={verifyOffsite}
            disabled={pending}
            className="btn-ghost"
          >
            Verify destination
          </button>
        )}
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
