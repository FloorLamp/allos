"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";
import Combobox from "@/components/Combobox";
import type { OverrideKind } from "@/lib/immunization-status";
import {
  IMMUNIZATION_EXEMPTION_TYPES,
  type ImmunizationExemptionType,
} from "@/lib/types";
import { setImmunizationOverride, clearImmunizationOverride } from "../actions";

// Per-vaccine override controls on the detail view. Lets the active
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

// Structured exemption categories (#1406). A school / camp / employer form asks
// which KIND of exemption a declination is, and the free-text reason could not
// answer that. Only offered for a declination — an "immune" override is not an
// exemption — and "Not stated" stays the default: unstated is a real answer.
const EXEMPTION_LABELS: Record<ImmunizationExemptionType, string> = {
  medical: "Medical exemption",
  religious: "Religious exemption",
  philosophical: "Philosophical / personal-belief exemption",
};

export default function OverrideControls({
  vaccine,
  current,
}: {
  vaccine: string;
  current: {
    kind: OverrideKind;
    reason: string | null;
    exemption_type: ImmunizationExemptionType | null;
    note: string | null;
  } | null;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<OverrideKind>(current?.kind ?? "immune");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [exemption, setExemption] = useState<string>(
    current?.exemption_type ?? ""
  );
  const reasons = kind === "immune" ? IMMUNE_REASONS : DECLINED_REASONS;

  async function save(formData: FormData) {
    formData.set("vaccine", vaccine);
    formData.set("kind", kind);
    await setImmunizationOverride(formData);
    toast("Override saved");
  }

  async function clear() {
    const fd = new FormData();
    fd.set("vaccine", vaccine);
    await clearImmunizationOverride(fd);
    toast("Override removed");
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
            {current.exemption_type
              ? ` · ${EXEMPTION_LABELS[current.exemption_type]}`
              : ""}
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
        {kind === "declined" && (
          <div>
            <label className="label" htmlFor="override-exemption">
              Exemption type (optional)
            </label>
            <select
              id="override-exemption"
              name="exemption_type"
              className="input"
              data-testid="override-exemption"
              value={exemption}
              onChange={(e) => setExemption(e.target.value)}
            >
              <option value="">Not stated</option>
              {IMMUNIZATION_EXEMPTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EXEMPTION_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="override-reason">
            Reason (optional)
          </label>
          <Combobox
            id="override-reason"
            name="reason"
            ariaLabel="Reason"
            value={reason}
            onChange={setReason}
            options={reasons}
            allowFreeText
            placeholder="e.g. Prior infection"
          />
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
