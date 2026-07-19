"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  SUBSTANCE_INSTRUMENTS,
  substanceInstrumentDef,
  substanceSeverityBand,
  type SubstanceInstrument,
} from "@/lib/substance-use";
import { recordSubstanceInstrumentAction } from "./actions";

// The substance-instrument capture form (#998) — the #716 guided-battery pattern:
// an in-app AUDIT-C tap-through that computes the score client-side for preview
// (the server re-derives it from the answers), plus outside total-only entry for
// AUDIT and DAST-10, whose item text is deliberately NOT reproduced in-app (the
// licensing determination in lib/substance-use.ts). DELIBERATELY calm: no streaks,
// no milestones, no "improve your score" copy — a screening tool, not a diagnosis,
// and never gamified.

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function SubstanceInstrumentsForm({
  defaultDate,
}: {
  defaultDate: string;
}) {
  const router = useRouter();
  const [instrument, setInstrument] = useState<SubstanceInstrument>("AUDIT-C");
  const [mode, setMode] = useState<"administer" | "outside">("administer");
  const [date, setDate] = useState(defaultDate || todayISO());
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [outsideTotal, setOutsideTotal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = substanceInstrumentDef(instrument);
  const inApp = def.entry === "in-app";
  const effectiveMode = inApp ? mode : "outside";

  function reset() {
    setAnswers({});
    setOutsideTotal("");
    setError(null);
  }

  function pickInstrument(next: SubstanceInstrument) {
    setInstrument(next);
    reset();
  }

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === def.items.length;
  const runningTotal = Object.values(answers).reduce((a, b) => a + b, 0);
  const band =
    inApp && allAnswered
      ? substanceSeverityBand(instrument, runningTotal)
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData();
    fd.set("instrument", instrument);
    fd.set("date", date);
    fd.set("mode", effectiveMode);
    if (effectiveMode === "administer") {
      const arr = def.items.map((_, i) => answers[i]);
      fd.set("answers", JSON.stringify(arr));
    } else {
      fd.set("total", outsideTotal);
    }
    const r = await recordSubstanceInstrumentAction(fd);
    setPending(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reset();
    router.refresh();
  }

  return (
    <div
      className="space-y-4 rounded-xl border border-black/10 p-4 dark:border-white/10"
      data-testid="substance-instruments-form"
    >
      {/* Instrument picker */}
      <div className="flex flex-wrap gap-2">
        {SUBSTANCE_INSTRUMENTS.map((k) => {
          const d = substanceInstrumentDef(k);
          const active = k === instrument;
          return (
            <button
              key={k}
              type="button"
              onClick={() => pickInstrument(k)}
              data-testid={`substance-instrument-select-${k}`}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                active
                  ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                  : "border-black/10 dark:border-white/10"
              }`}
            >
              {d.title} · {d.measures}
            </button>
          );
        })}
      </div>

      {/* Mode toggle — only for the in-app instrument; AUDIT / DAST-10 are
          total-only (item text not reproduced — see lib/substance-use.ts). */}
      {inApp ? (
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="substance-mode"
              checked={mode === "administer"}
              onChange={() => {
                setMode("administer");
                setError(null);
              }}
            />
            Answer in app
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="substance-mode"
              checked={mode === "outside"}
              onChange={() => {
                setMode("outside");
                setError(null);
              }}
            />
            Enter a score from elsewhere
          </label>
        </div>
      ) : (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="substance-total-only-note"
        >
          The {def.title} is answered with a clinician or on paper; its question
          text isn&rsquo;t reproduced here. Enter the total score (0–
          {def.maxTotal}).
        </p>
      )}

      <label className="block text-sm">
        <span className="text-slate-500 dark:text-slate-400">Date</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 block rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
          data-testid="substance-instrument-date"
        />
      </label>

      <form onSubmit={submit} className="space-y-4">
        {effectiveMode === "administer" ? (
          <>
            {def.items.map((item, i) => (
              <fieldset
                key={i}
                className="rounded-lg border border-black/5 p-3 dark:border-white/5"
                data-testid={`substance-item-${i}`}
              >
                <legend className="text-sm font-medium">
                  {i + 1}. {item.prompt}
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.options.map((opt) => {
                    const selected = answers[i] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setAnswers((a) => ({ ...a, [i]: opt.value }))
                        }
                        data-testid={`substance-option-${i}-${opt.value}`}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          selected
                            ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                            : "border-black/10 dark:border-white/10"
                        }`}
                      >
                        {opt.value} · {opt.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <div
              className="flex items-center justify-between text-sm"
              data-testid="substance-running"
            >
              <span className="text-slate-500 dark:text-slate-400">
                {answeredCount} of {def.items.length} answered
              </span>
              {band ? (
                <span data-testid="substance-band">
                  Total{" "}
                  <span className="font-semibold" data-testid="substance-total">
                    {runningTotal}
                  </span>{" "}
                  · {band.label}
                </span>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={pending || !allAnswered}
              data-testid="substance-instrument-submit"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save score"}
            </button>
          </>
        ) : (
          <>
            <label className="block text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                {def.title} total (0–{def.maxTotal})
              </span>
              <input
                type="number"
                min={0}
                max={def.maxTotal}
                value={outsideTotal}
                onChange={(e) => setOutsideTotal(e.target.value)}
                data-testid="substance-outside-total"
                className="mt-1 block w-28 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
              />
            </label>
            <button
              type="submit"
              disabled={pending || outsideTotal === ""}
              data-testid="substance-instrument-submit-outside"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save score"}
            </button>
          </>
        )}

        {error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : null}
      </form>
    </div>
  );
}
