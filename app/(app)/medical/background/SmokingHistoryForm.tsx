"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSmokingHistory } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus, useFlushOnHide } from "@/components/useSaveStatus";
import type { SmokingHistory, SmokingStatusValue } from "@/lib/smoking";

// Structured smoking history (issue #83) — a PROFILE-scoped property of the tracked
// person, following the active profile like sex/birthdate. Status is the tri-state
// the risk-gated screening reminders need (lung LDCT, AAA); pack-years show for an
// ever-smoker and the quit year for a former smoker. Informational only — not
// medical advice.
export default function SmokingHistoryForm({
  history,
}: {
  history: SmokingHistory;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<SmokingStatusValue | "">(
    history.status ?? ""
  );
  const [packYears, setPackYears] = useState(
    history.packYears == null ? "" : String(history.packYears)
  );
  const [quitYear, setQuitYear] = useState(
    history.quitYear == null ? "" : String(history.quitYear)
  );
  const { pending, savedAt, error, save: runSave } = useSaveStatus();
  const formRef = useRef<HTMLDivElement>(null);
  useFlushOnHide(formRef);

  const everSmoker = status === "former" || status === "current";
  const isFormer = status === "former";

  function save(next: {
    status: SmokingStatusValue | "";
    packYears: string;
    quitYear: string;
  }) {
    const fd = new FormData();
    fd.set("smoking_status", next.status);
    // pack-years apply only to an ever-smoker; the quit year only to a former
    // smoker. The server drops the rest regardless — send blanks to be explicit.
    fd.set(
      "pack_years",
      next.status === "former" || next.status === "current"
        ? next.packYears
        : ""
    );
    fd.set("quit_year", next.status === "former" ? next.quitYear : "");
    runSave(async () => {
      await saveSmokingHistory(fd);
      router.refresh();
    });
  }

  return (
    <div
      ref={formRef}
      // Anchor target for the data-quality smoking-status CTA (#1146):
      // /records/care/overview#smoking-history lands on THIS form, not the page top.
      id="smoking-history"
      className="card max-w-lg scroll-mt-24 space-y-5"
      data-testid="smoking-history"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Smoking history
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label" htmlFor="smoking-status">
          Tobacco smoking status
        </label>
        <select
          id="smoking-status"
          data-testid="smoking-status"
          value={status}
          onChange={(e) => {
            const v = e.target.value as SmokingStatusValue | "";
            setStatus(v);
            save({ status: v, packYears, quitYear });
          }}
          className="input"
        >
          <option value="">Not recorded</option>
          <option value="never">Never smoked</option>
          <option value="former">Former smoker</option>
          <option value="current">Current smoker</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Used to surface the smoking-related screening reminders (low-dose CT
          lung screening; abdominal aortic aneurysm ultrasound). Leave as
          &ldquo;Not recorded&rdquo; if you&rsquo;d rather not say.
        </p>
      </div>

      {everSmoker && (
        <div className="grid grid-cols-2 gap-3 border-t border-black/5 pt-5 dark:border-white/10">
          <div>
            <label className="label" htmlFor="pack-years">
              Pack-years
            </label>
            <input
              id="pack-years"
              data-testid="smoking-pack-years"
              type="number"
              min={0}
              max={200}
              step="0.5"
              value={packYears}
              placeholder="e.g. 20"
              onChange={(e) => setPackYears(e.target.value)}
              onBlur={() => save({ status, packYears, quitYear })}
              className="input"
            />
          </div>
          {isFormer && (
            <div>
              <label className="label" htmlFor="quit-year">
                Year you quit
              </label>
              <input
                id="quit-year"
                data-testid="smoking-quit-year"
                type="number"
                min={1900}
                max={new Date().getFullYear()}
                value={quitYear}
                placeholder="e.g. 2015"
                onChange={(e) => setQuitYear(e.target.value)}
                onBlur={() => save({ status, packYears, quitYear })}
                className="input"
              />
            </div>
          )}
          <p className="col-span-2 text-xs text-slate-500 dark:text-slate-400">
            A pack-year is one pack a day for a year. Lung screening is
            generally considered around 20+ pack-years for those still smoking
            or who quit within the last 15 years.
          </p>
        </div>
      )}

      <p className="border-t border-black/5 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        Privacy: smoking history is sensitive. Like the rest of this
        profile&rsquo;s medical passport, anyone granted access to this profile
        (and any admin) can see it. It is informational only and not medical
        advice.
      </p>
    </div>
  );
}
