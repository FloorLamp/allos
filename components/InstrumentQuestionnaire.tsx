"use client";

import { useEffect, useRef, useState } from "react";
import DateField from "@/components/DateField";
import { useAddEntryModalClose } from "@/components/AddEntryPanel";

interface QuestionnaireDefinition {
  title: string;
  measures: string;
  entry: "in-app" | "total-only";
  instructions?: string;
  maxTotal: number;
  items: readonly {
    prompt: string;
    options: readonly { value: number; label: string }[];
  }[];
}

// Definitions own instrument wording and scoring; each surface supplies its gated action.
export default function InstrumentQuestionnaire<K extends string>({
  defaultDate,
  initialInstrument,
  instruments,
  definition,
  severityBand,
  recordAction,
  idPrefix = "",
}: {
  defaultDate: string;
  initialInstrument?: K;
  instruments: readonly [K, ...K[]];
  definition: (instrument: K) => QuestionnaireDefinition;
  severityBand: (instrument: K, total: number) => { label: string } | null;
  recordAction: (
    data: FormData
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  idPrefix?: string;
}) {
  const closeEntryModal = useAddEntryModalClose();
  const containerRef = useRef<HTMLDivElement>(null);
  const [instrument, setInstrument] = useState<K>(
    initialInstrument ?? instruments[0]
  );
  const itemPrefix = idPrefix || "instrument-";
  const [mode, setMode] = useState<"administer" | "outside">("administer");
  const [date, setDate] = useState(defaultDate);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [outsideTotal, setOutsideTotal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def = definition(instrument);
  const inApp = def.entry === "in-app";
  const effectiveMode = inApp ? mode : "outside";

  // Focus a deep-linked instrument once on mount.
  useEffect(() => {
    if (!initialInstrument) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.querySelector<HTMLButtonElement>("button")?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setAnswers({});
    setOutsideTotal("");
    setError(null);
  }

  function pickInstrument(next: K) {
    setInstrument(next);
    reset();
  }

  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === def.items.length;
  const runningTotal = Object.values(answers).reduce((a, b) => a + b, 0);
  const band =
    inApp && allAnswered ? severityBand(instrument, runningTotal) : null;

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
    const r = await recordAction(fd);
    setPending(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reset();
    closeEntryModal?.();
  }

  return (
    <div
      ref={containerRef}
      className="space-y-4"
      data-testid={`${idPrefix}instruments-form`}
    >
      {/* Instrument picker */}
      <div className="flex flex-wrap gap-2">
        {instruments.map((k) => {
          const d = definition(k);
          const active = k === instrument;
          return (
            <button
              key={k}
              type="button"
              onClick={() => pickInstrument(k)}
              data-testid={`${idPrefix}instrument-select-${k}`}
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

      {/* Total-only instruments do not expose an in-app questionnaire. */}
      {inApp ? (
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${idPrefix}mode`}
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
              name={`${idPrefix}mode`}
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
          data-testid={`${idPrefix}total-only-note`}
        >
          The {def.title} is answered with a clinician or on paper; its question
          text isn’t reproduced here. Enter the total score (0–
          {def.maxTotal}).
        </p>
      )}

      <label className="block text-sm" htmlFor={`${idPrefix}instrument-date`}>
        <span className="text-slate-500 dark:text-slate-400">Date</span>
        <div className="mt-1 max-w-xs">
          <DateField
            id={`${idPrefix}instrument-date`}
            value={date}
            onChange={setDate}
            data-testid={`${idPrefix}instrument-date`}
          />
        </div>
      </label>

      <form onSubmit={submit} className="space-y-4">
        {effectiveMode === "administer" ? (
          <>
            {def.instructions ? (
              <p
                className="text-sm text-slate-500 dark:text-slate-400"
                data-testid={`${idPrefix}instrument-instructions`}
              >
                {def.instructions}
              </p>
            ) : null}
            {def.items.map((item, i) => (
              <fieldset
                key={i}
                className="rounded-lg border border-black/5 p-3 dark:border-white/5"
                data-testid={`${itemPrefix}item-${i}`}
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
                        data-testid={`${itemPrefix}option-${i}-${opt.value}`}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          selected
                            ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                            : "border-black/10 dark:border-white/10"
                        }`}
                      >
                        {/* Keep yes/no answers neutral; do not reveal reverse scoring. */}
                        {item.options.length > 2
                          ? `${opt.value} · ${opt.label}`
                          : opt.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            <div
              className="flex items-center justify-between text-sm"
              data-testid={`${itemPrefix}running`}
            >
              <span className="text-slate-500 dark:text-slate-400">
                {answeredCount} of {def.items.length} answered
              </span>
              {band ? (
                <span data-testid={`${itemPrefix}band`}>
                  Total{" "}
                  <span
                    className="font-semibold"
                    data-testid={`${itemPrefix}total`}
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
              data-testid={`${idPrefix}instrument-submit`}
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
                data-testid={`${itemPrefix}outside-total`}
                className="mt-1 block w-28 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
              />
            </label>
            <button
              type="submit"
              disabled={pending || outsideTotal === ""}
              data-testid={`${idPrefix}instrument-submit-outside`}
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
