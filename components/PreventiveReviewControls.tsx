"use client";

import { useState } from "react";
import DateField from "@/components/DateField";
import { SubmitActionChip } from "@/components/Button";
import type { FormResult } from "@/lib/types";

// The preventive REVIEW CANDIDATE controls (issue #3025), shared by the Upcoming
// row and dashboard Show everything so the offer reads identically on both.
// A valueless imported report matched exactly one screening rule, so the app ASKS
// — "does this record show the screening was completed?" — and the person
// answers:
//   - Confirm: writes the explicit record↔rule decision with the date shown in
//     the control. The record's own date only PREFILLS it; the person confirms
//     or changes it before anything is written (an import-day fallback must not
//     silently become a clinical date).
//   - Dismiss: stops offering THIS candidate. It makes no claim about the
//     screening and leaves the preventive item exactly as it was.
// The app never auto-satisfies from the title; this explicit answer is the only
// path prose has.
export default function PreventiveReviewControls({
  confirmAction,
  dismissAction,
  recordId,
  ruleKey,
  recordName,
  recordDate,
  question,
  today,
  profileId,
}: {
  confirmAction: (formData: FormData) => Promise<FormResult>;
  dismissAction: (formData: FormData) => Promise<FormResult>;
  recordId: number;
  ruleKey: string;
  recordName: string;
  // The record's stored day (YYYY-MM-DD) — the date control's PREFILL only.
  recordDate: string;
  // The rendered ask, e.g. "Does this record show that cervical cancer
  // screening was completed? Confirm the date."
  question: string;
  // The subject profile's local today (YYYY-MM-DD): the date input's max.
  today: string;
  // The item's OWNING profile (issue #1096): on a multi-view surface the write
  // must target the ITEM's profile. Omitted on single-view (active profile).
  profileId?: number;
}) {
  const [error, setError] = useState<string | null>(null);

  const run =
    (action: (formData: FormData) => Promise<FormResult>) =>
    async (fd: FormData) => {
      const res = await action(fd);
      if (!res.ok) setError(res.error);
      else setError(null); // the revalidated page drops the answered candidate
    };

  const hidden = (
    <>
      <input type="hidden" name="record_id" value={recordId} />
      <input type="hidden" name="rule_key" value={ruleKey} />
      {profileId != null && (
        <input type="hidden" name="profile_id" value={profileId} />
      )}
    </>
  );

  return (
    <div
      data-testid={`preventive-review-${recordId}-${ruleKey}`}
      className="rounded-lg border border-black/5 bg-slate-50 px-2.5 py-2 dark:border-white/5 dark:bg-ink-850"
    >
      <div className="text-xs text-slate-600 dark:text-slate-300">
        {question}
      </div>
      <div
        data-testid={`preventive-review-record-${recordId}-${ruleKey}`}
        className="mt-0.5 truncate text-xs font-medium text-slate-700 dark:text-slate-200"
      >
        {recordName}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <form
          action={run(confirmAction)}
          className="flex items-center gap-1"
          data-testid={`preventive-review-confirm-form-${recordId}-${ruleKey}`}
        >
          {hidden}
          <DateField
            name="confirmed_date"
            defaultValue={recordDate.slice(0, 10)}
            max={today}
            required
            data-testid={`preventive-review-date-${recordId}-${ruleKey}`}
            inputClassName="w-32 py-1 text-xs"
          />
          <SubmitActionChip
            pendingLabel="…"
            data-testid={`preventive-review-confirm-${recordId}-${ruleKey}`}
          >
            Confirm
          </SubmitActionChip>
        </form>
        <form action={run(dismissAction)}>
          {hidden}
          <SubmitActionChip
            pendingLabel="…"
            data-testid={`preventive-review-dismiss-${recordId}-${ruleKey}`}
          >
            Dismiss
          </SubmitActionChip>
        </form>
        {error && (
          <span
            data-testid={`preventive-review-error-${recordId}-${ruleKey}`}
            className="text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
