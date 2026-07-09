"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";
import type { OverrideKind } from "@/lib/immunization-status";
import { setImmunizationOverride, clearImmunizationOverride } from "../actions";

// Per-vaccine override controls on the detail view (issue #155). Lets the active
// profile mark a vaccine "Immune" (counts the series complete despite missing
// doses) or "Not tracking / Declined" (drops it from needs-attention). The
// current override (if any) is shown with a Remove control. Reasons are optional
// hints stored alongside the override.
const IMMUNE_REASONS = [
  "Titer confirmed",
  "Prior infection",
  "Clinician-assessed",
];
const DECLINED_REASONS = ["Personal choice", "Medical exemption", "Not needed"];

export default function OverrideControls({
  vaccine,
  current,
}: {
  vaccine: string;
  current: {
    kind: OverrideKind;
    reason: string | null;
    note: string | null;
  } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<OverrideKind>(current?.kind ?? "immune");
  const reasons = kind === "immune" ? IMMUNE_REASONS : DECLINED_REASONS;

  async function save(formData: FormData) {
    formData.set("vaccine", vaccine);
    formData.set("kind", kind);
    await setImmunizationOverride(formData);
    toast("Override saved");
    router.refresh();
  }

  async function clear() {
    const fd = new FormData();
    fd.set("vaccine", vaccine);
    await clearImmunizationOverride(fd);
    toast("Override removed");
    router.refresh();
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Status override
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Override the computed status for this vaccine on this profile.
        </p>
      </div>

      {current && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-ink-800/60">
          <span className="text-slate-600 dark:text-slate-300">
            Current override:{" "}
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {current.kind === "immune"
                ? "Immune (self-reported)"
                : "Not tracking / declined"}
            </span>
            {current.reason ? ` · ${current.reason}` : ""}
            {current.note ? ` · ${current.note}` : ""}
          </span>
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1 font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
          >
            Remove override
          </button>
        </div>
      )}

      <form action={save} className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setKind("immune")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              kind === "immune"
                ? "bg-emerald-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
            }`}
          >
            Immune
          </button>
          <button
            type="button"
            onClick={() => setKind("declined")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              kind === "declined"
                ? "bg-slate-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-300"
            }`}
          >
            Not tracking / Declined
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {kind === "immune"
            ? "Counts the series as complete regardless of dose count."
            : "Drops the vaccine from needs-attention and shows it as Declined."}
        </p>
        <div>
          <label className="label" htmlFor="override-reason">
            Reason (optional)
          </label>
          <input
            id="override-reason"
            name="reason"
            list="override-reasons"
            className="input"
            defaultValue={current?.reason ?? ""}
            placeholder="e.g. Prior infection"
          />
          <datalist id="override-reasons">
            {reasons.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="override-note">
            Note (optional)
          </label>
          <input
            id="override-note"
            name="note"
            className="input"
            defaultValue={current?.note ?? ""}
          />
        </div>
        <SubmitButton className="btn" pendingLabel="Saving…">
          {current ? "Update override" : "Set override"}
        </SubmitButton>
      </form>
    </div>
  );
}
