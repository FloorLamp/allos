"use client";

import type { Supplement } from "@/lib/types";

// The missed-dose escalation block shared by both intake forms (#846): mark an item
// critical so an unconfirmed scheduled dose reminder escalates with a follow-up nudge
// (optionally to a second chat, e.g. a caregiver). Applies to both kinds — a critical
// standing supplement escalates the same way a critical medication does — so it's
// shared machinery, not a kind concept. `critical` is controlled by the form so its
// state resets cleanly on an add-form save (#627).
export default function CriticalEscalation({
  fid,
  supplement,
  critical,
  setCritical,
}: {
  fid: string | number;
  supplement?: Supplement;
  critical: boolean;
  setCritical: (v: boolean) => void;
}) {
  const s = supplement;
  return (
    <div className="sm:col-span-2 border-t border-black/5 pt-4 dark:border-white/5">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          name="critical"
          value="1"
          data-testid={`supp-critical-${fid}`}
          checked={critical}
          onChange={(e) => setCritical(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-600"
        />
        Critical — escalate a missed dose
      </label>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        If a reminder for this dose goes unconfirmed, send a follow-up nudge
        (optionally to a second chat, e.g. a caregiver).
      </p>
      {critical && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`intake-escalate-after-${fid}`}>
              Escalate after (minutes)
            </label>
            <input
              id={`intake-escalate-after-${fid}`}
              name="escalate_after_min"
              type="number"
              min={1}
              defaultValue={s?.escalate_after_min ?? ""}
              className="input"
              placeholder="120"
            />
          </div>
          <div>
            <label className="label" htmlFor={`intake-escalate-chat-${fid}`}>
              Escalation chat ID (optional)
            </label>
            <input
              id={`intake-escalate-chat-${fid}`}
              name="escalate_chat_id"
              defaultValue={s?.escalate_chat_id ?? ""}
              className="input"
              placeholder="defaults to this profile’s chat"
            />
          </div>
        </div>
      )}
    </div>
  );
}
