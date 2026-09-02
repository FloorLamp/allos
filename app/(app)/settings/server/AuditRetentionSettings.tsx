"use client";

import {
  MIN_AUDIT_RETENTION_MONTHS,
  MAX_AUDIT_RETENTION_MONTHS,
} from "@/lib/retention";
import { saveAuditRetention } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// GLOBAL, admin-only: how long the security audit trail (`audit_events` — logins,
// PHI access, admin/family changes) is kept before the hourly notify tick prunes
// older rows (#98). Generous by default; self-hosters with their own compliance
// expectations can raise or lower it. The value is clamped server-side to
// [MIN, MAX] months.
export default function AuditRetentionSettings({ months }: { months: number }) {
  const { status, value, edit, save: runSave } = useSaveStatus(String(months));

  function save() {
    const fd = new FormData();
    fd.set("audit_retention_months", value.trim());
    runSave(value, async () => {
      await saveAuditRetention(fd);
    });
  }

  return (
    <div data-testid="audit-retention-settings" className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Audit-log retention
        </h2>
        <SaveStatus {...status} />
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        The security audit trail (logins, medical-file access, admin/family
        changes — Settings → Logs & audit → AI logs is separate) is kept for
        this many months, then the hourly notify tick prunes older events. The
        default is generous (24 months); raise or lower it to match your own
        retention needs. Allowed range: {MIN_AUDIT_RETENTION_MONTHS}–
        {MAX_AUDIT_RETENTION_MONTHS} months.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="label" htmlFor="audit-retention-months">
            Keep for (months)
          </label>
          <input
            id="audit-retention-months"
            data-testid="audit-retention-months"
            type="number"
            min={MIN_AUDIT_RETENTION_MONTHS}
            max={MAX_AUDIT_RETENTION_MONTHS}
            step={1}
            value={value}
            onChange={(e) => edit(e.target.value)}
            className="input"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={status.pending}
          className="btn"
          data-testid="audit-retention-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
