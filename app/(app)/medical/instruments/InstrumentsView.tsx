"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  INSTRUMENTS,
  INSTRUMENT_OPTIONS,
  instrumentDef,
  severityBand,
  type Instrument,
} from "@/lib/mental-health";
import { recordInstrumentAction } from "./actions";

// The mental-health instrument surface (#716) — a public-domain PHQ-9/GAD-7 tap-through
// that computes the score in-app (the guided-battery pattern, #834), plus an outside
// total-only entry. DELIBERATELY calm: no streaks, no milestones, no "improve your score"
// copy — a screening instrument, not a diagnosis, and never gamified.

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function InstrumentsView({
  defaultDate,
  initialInstrument,
}: {
  defaultDate: string;
  // Preselected instrument from a deep link (#1083): the preventive depression/anxiety-
  // screening row/nudge lands here via `?screen=<INSTRUMENT>`; the page validates the
  // param and passes it. Absent/unknown ⇒ the PHQ-9 default.
  initialInstrument?: Instrument;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [instrument, setInstrument] = useState<Instrument>(
    initialInstrument ?? "PHQ-9"
  );
  const [mode, setMode] = useState<"administer" | "outside">("administer");
  const [date, setDate] = useState(defaultDate || todayISO());
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [outsideTotal, setOutsideTotal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = instrumentDef(instrument);

  function reset() {
    setAnswers({});
    setOutsideTotal("");
    setError(null);
  }

  function pickInstrument(next: Instrument) {
    setInstrument(next);
    reset();
  }

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === def.items.length;
  const runningTotal = Object.values(answers).reduce((a, b) => a + b, 0);
  const band = allAnswered ? severityBand(instrument, runningTotal) : null;

  // Arrived via a `?screen=` deep link (#1083): scroll the preselected form into
  // view + focus it so the next action is front-and-center. Runs once.
  useEffect(() => {
    if (!initialInstrument) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.querySelector<HTMLButtonElement>("button")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData();
    fd.set("instrument", instrument);
    fd.set("date", date);
    fd.set("mode", mode);
    if (mode === "administer") {
      const arr = def.items.map((_, i) => answers[i]);
      fd.set("answers", JSON.stringify(arr));
    } else {
      fd.set("total", outsideTotal);
    }
    const r = await recordInstrumentAction(fd);
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
      ref={containerRef}
      className="space-y-4 rounded-xl border border-black/10 p-4 dark:border-white/10"
      data-testid="instruments-form"
    >
      {/* Instrument picker */}
      <div className="flex flex-wrap gap-2">
        {INSTRUMENTS.map((k) => {
          const d = instrumentDef(k);
          const active = k === instrument;
          return (
            <button
              key={k}
              type="button"
              onClick={() => pickInstrument(k)}
              data-testid={`instrument-select-${k}`}
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

      {/* Mode toggle */}
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="mode"
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
            name="mode"
            checked={mode === "outside"}
            onChange={() => {
              setMode("outside");
              setError(null);
            }}
          />
          Enter a score from elsewhere
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-slate-500 dark:text-slate-400">Date</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 block rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
          data-testid="instrument-date"
        />
      </label>

      <form onSubmit={submit} className="space-y-4">
        {mode === "administer" ? (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Over the last 2 weeks, how often have you been bothered by the
              following?
            </p>
            {def.items.map((item, i) => (
              <fieldset
                key={i}
                className="rounded-lg border border-black/5 p-3 dark:border-white/5"
                data-testid={`instrument-item-${i}`}
              >
                <legend className="text-sm font-medium">
                  {i + 1}. {item}
                </legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {INSTRUMENT_OPTIONS.map((opt) => {
                    const selected = answers[i] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setAnswers((a) => ({ ...a, [i]: opt.value }))
                        }
                        data-testid={`instrument-option-${i}-${opt.value}`}
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
              data-testid="instrument-running"
            >
              <span className="text-slate-500 dark:text-slate-400">
                {answeredCount} of {def.items.length} answered
              </span>
              {band ? (
                <span data-testid="instrument-band">
                  Total{" "}
                  <span
                    className="font-semibold"
                    data-testid="instrument-total"
                  >
                    {runningTotal}
                  </span>{" "}
                  · {band.label}
                </span>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={pending || !allAnswered}
              data-testid="instrument-submit"
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
                data-testid="instrument-outside-total"
                className="mt-1 block w-28 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
              />
            </label>
            <button
              type="submit"
              disabled={pending || outsideTotal === ""}
              data-testid="instrument-submit-outside"
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
