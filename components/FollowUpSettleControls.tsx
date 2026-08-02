"use client";

import { useState } from "react";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import type { FormResult } from "@/lib/types";

const CHIP =
  "rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750";

// The finding follow-up TERMINATOR controls (issue #1866): the first-class,
// per-item resolve/decline action that permanently ends the overdue-push
// escalation AND closes the chain node —
//   - "Done on <date>": the follow-up happened outside our records;
//   - "Not doing it":   discussed and deliberately declined, optional reason.
// This is the ONLY off-switch for the #1866 escalation (there is no notification
// setting anywhere, by owner ruling), so it lives inline where the follow-up
// renders. The form posts ids only; the action answers a typed FormResult and a
// refusal (already closed, bad date) renders inline instead of a false confirm.
export default function FollowUpSettleControls({
  action,
  carePlanItemId,
  today,
  profileId,
}: {
  action: (formData: FormData) => Promise<FormResult>;
  carePlanItemId: number;
  // The item-profile's local today (YYYY-MM-DD): the date input's default and max.
  today: string;
  // The item's OWNING profile (issue #1096): on a multi-view surface the settle
  // must target the ITEM's profile. Omitted on single-view (active profile).
  profileId?: number;
}) {
  const [mode, setMode] = useState<"done" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (mode == null) {
    return (
      <div
        data-testid={`followup-settle-${carePlanItemId}`}
        className="flex shrink-0 items-center gap-1"
      >
        <button
          type="button"
          data-testid={`followup-settle-done-${carePlanItemId}`}
          className={CHIP}
          onClick={() => {
            setError(null);
            setMode("done");
          }}
        >
          Done…
        </button>
        <button
          type="button"
          data-testid={`followup-settle-decline-${carePlanItemId}`}
          className={CHIP}
          onClick={() => {
            setError(null);
            setMode("declined");
          }}
        >
          Not doing it…
        </button>
      </div>
    );
  }

  return (
    <form
      action={async (fd) => {
        const res = await action(fd);
        if (!res.ok) setError(res.error);
        else setMode(null); // the revalidated page drops the settled row
      }}
      data-testid={`followup-settle-form-${carePlanItemId}`}
      className="flex shrink-0 flex-wrap items-center gap-1"
    >
      <input type="hidden" name="care_plan_item_id" value={carePlanItemId} />
      <input type="hidden" name="disposition" value={mode} />
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
      {mode === "done" && (
        <DateField
          name="settled_on"
          defaultValue={today}
          max={today}
          required
          data-testid={`followup-settle-date-${carePlanItemId}`}
          inputClassName="w-32 py-1 text-xs"
        />
      )}
      <input
        type="text"
        name="reason"
        aria-label="Reason (optional)"
        placeholder={
          mode === "declined" ? "Reason (optional)" : "Note (optional)"
        }
        maxLength={500}
        className="input w-36 py-1 text-xs"
      />
      <SubmitButton pendingLabel="…" className={CHIP}>
        {mode === "done" ? "Mark done" : "Decline"}
      </SubmitButton>
      <button
        type="button"
        className={CHIP}
        onClick={() => {
          setError(null);
          setMode(null);
        }}
      >
        Cancel
      </button>
      {error && (
        <span
          data-testid={`followup-settle-error-${carePlanItemId}`}
          className="text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </span>
      )}
    </form>
  );
}
