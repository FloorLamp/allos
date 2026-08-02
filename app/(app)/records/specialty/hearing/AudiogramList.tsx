"use client";

import { useState } from "react";
import NotesText from "@/components/NotesText";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  AUDIOGRAM_EARS,
  AUDIOGRAM_FREQUENCIES_HZ,
  audiogramSeriesKey,
  earLabel,
  frequencyLabel,
  hearingGrade,
  hearingGradeLabel,
  NORMAL_THRESHOLD_DB_HL,
  pureToneAverage,
  thresholdShiftLabel,
  type Audiogram,
  type AudiogramPoint,
  type HearingBaseline,
} from "@/lib/audiogram";
import type { FormResult } from "@/lib/types";

// The profile's dated hearing tests, newest first (issue #1600). Each card is ONE
// audiogram: the per-ear pure-tone average with its descriptive grade, the full
// threshold grid, and the test's note. A threshold above the ≤25 dB HL normal band is
// marked — the same band the stored readings flag against, so this card and the
// Biomarkers surface can never say different things about the same number.
//
// This is a RECORD, not an assessment: it transcribes, averages, and compares what an
// audiologist measured. It never diagnoses, and the copy says so.
export default function AudiogramList({
  audiograms,
  baseline,
  onDelete,
}: {
  audiograms: Audiogram[];
  baseline: HearingBaseline | null;
  onDelete: (formData: FormData) => Promise<FormResult>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (audiograms.length === 0) {
    return (
      <p
        className="px-1 text-sm text-slate-500 dark:text-slate-400"
        data-testid="audiogram-empty"
      >
        No hearing tests recorded yet. Add one from an audiologist&apos;s report
        to start a baseline.
      </p>
    );
  }

  async function remove(date: string) {
    const ok = await confirm({
      title: "Delete this hearing test?",
      message: `Every threshold recorded on ${date} will be removed.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(date);
    try {
      const fd = new FormData();
      fd.set("date", date);
      const result = await onDelete(fd);
      toast(result.ok ? "Hearing test deleted" : result.error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {baseline && baseline.shifts.length > 0 && (
        <div
          className="card border-amber-300 text-sm dark:border-amber-700"
          data-testid="audiogram-shift"
        >
          <p className="font-medium">
            Threshold shift since {baseline.baselineDate}
          </p>
          <ul className="mt-1 list-disc pl-5 text-slate-600 dark:text-slate-300">
            {baseline.shifts.map((s) => (
              <li key={`${s.ear}-${s.criterion}`}>{thresholdShiftLabel(s)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Measured against the ASHA ototoxicity-monitoring criteria (20 dB at
            one frequency, or 10 dB at two adjacent frequencies). It compares
            recorded numbers — bring it to your audiologist or prescriber.
          </p>
        </div>
      )}

      {audiograms.map((a) => {
        const points: AudiogramPoint[] = a.readings.map((r) => ({
          ear: r.ear,
          hz: r.hz,
          dbHl: r.dbHl,
        }));
        const byKey = new Map(
          a.readings.map((r) => [audiogramSeriesKey(r.ear, r.hz), r] as const)
        );
        const testedFrequencies = AUDIOGRAM_FREQUENCIES_HZ.filter((hz) =>
          AUDIOGRAM_EARS.some((ear) => byKey.has(audiogramSeriesKey(ear, hz)))
        );
        return (
          <div
            key={a.date}
            className="card space-y-3"
            data-testid={`audiogram-${a.date}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{a.date}</p>
              <button
                type="button"
                className="btn-ghost text-sm"
                disabled={busy === a.date}
                onClick={() => remove(a.date)}
              >
                Delete
              </button>
            </div>

            <div className="flex flex-wrap gap-4 text-sm">
              {AUDIOGRAM_EARS.map((ear) => {
                const pta = pureToneAverage(points, ear);
                if (!pta) return null;
                return (
                  <p key={ear} data-testid={`audiogram-pta-${a.date}-${ear}`}>
                    <span className="capitalize">{earLabel(ear)}</span> average{" "}
                    <span className="font-medium">{pta.dbHl} dB HL</span>{" "}
                    <span className="text-slate-500 dark:text-slate-400">
                      · {hearingGradeLabel(hearingGrade(pta.dbHl))}
                    </span>
                  </p>
                );
              })}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    <th scope="col" className="w-24 py-1 text-left">
                      Frequency
                    </th>
                    {AUDIOGRAM_EARS.map((ear) => (
                      <th
                        key={ear}
                        scope="col"
                        className="py-1 text-left capitalize"
                      >
                        {earLabel(ear)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {testedFrequencies.map((hz) => (
                    <tr key={hz}>
                      <th
                        scope="row"
                        className="py-1 pr-2 text-left text-xs font-medium text-slate-600 dark:text-slate-300"
                      >
                        {frequencyLabel(hz)}
                      </th>
                      {AUDIOGRAM_EARS.map((ear) => {
                        const r = byKey.get(audiogramSeriesKey(ear, hz));
                        if (!r)
                          return (
                            <td
                              key={ear}
                              className="py-1 pr-2 text-slate-500 dark:text-slate-400"
                            >
                              —
                            </td>
                          );
                        const above = r.dbHl > NORMAL_THRESHOLD_DB_HL;
                        return (
                          <td key={ear} className="py-1 pr-2">
                            <span
                              className={
                                above
                                  ? "font-medium text-amber-700 dark:text-amber-400"
                                  : undefined
                              }
                            >
                              {r.dbHl} dB HL
                            </span>
                            {above && (
                              <span className="sr-only">
                                {" "}
                                above the normal band
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <NotesText
              notes={a.notes}
              as="p"
              className="text-sm text-slate-600 dark:text-slate-300"
            />
          </div>
        );
      })}
    </div>
  );
}
