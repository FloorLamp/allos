"use client";

import SubmitButton from "@/components/SubmitButton";

// The confirm-first (#560) finding-follow-up resolution controls (issue #700 ask 3),
// shared by BOTH the Upcoming page and the dashboard "Needs attention" hero so the
// offer reads and behaves identically on every surface. When a matching later record
// has landed, the follow-up row offers three outcomes — Resolved / Stable / Changed —
// each a submit button in ONE form that posts its `resolution` value plus the
// follow-up id and the resolving record id to the shared resolveFollowUp action. The
// app never auto-resolves; the outcome is always this explicit click.
export default function FollowUpResolveControls({
  action,
  carePlanItemId,
  resolvingRecordId,
}: {
  action: (formData: FormData) => Promise<void>;
  carePlanItemId: number;
  resolvingRecordId: number;
}) {
  return (
    <form
      action={action}
      data-testid={`followup-resolve-${carePlanItemId}`}
      className="flex shrink-0 items-center gap-1"
    >
      <input type="hidden" name="care_plan_item_id" value={carePlanItemId} />
      <input
        type="hidden"
        name="resolving_study_id"
        value={resolvingRecordId}
      />
      {(
        [
          ["resolved", "Resolved"],
          ["stable", "Stable"],
          ["changed", "Changed"],
        ] as const
      ).map(([value, label]) => (
        <SubmitButton
          key={value}
          name="resolution"
          value={value}
          pendingLabel="…"
          className="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          {label}
        </SubmitButton>
      ))}
    </form>
  );
}
