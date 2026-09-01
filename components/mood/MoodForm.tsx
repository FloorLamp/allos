"use client";

import { useState } from "react";
import { logMood } from "@/app/(app)/mood-actions";
import Disclosure from "@/components/Disclosure";
import MoodValencePicker from "@/components/MoodValencePicker";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useToast } from "@/components/Toast";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import {
  ANXIETY_CALM_HIGH_LABEL,
  ANXIETY_CALM_LOW_LABEL,
  MOOD_FACTORS,
  anxietyDisplaySlot,
  anxietyStoredValue,
  moodBackfillLabel,
  moodLabel,
} from "@/lib/mood";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";

export interface MoodFormValue {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
}

export interface MoodFormDay {
  date: string;
  mood: MoodFormValue | null;
}

function ScaleRow({
  name,
  value,
  onPick,
  testPrefix,
  lowLabel,
  highLabel,
}: {
  name: string;
  value: number | null;
  onPick: (value: number) => void;
  testPrefix: string;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="w-16 text-xs text-slate-500 dark:text-slate-400">
        {name}
      </legend>
      <span className="text-xs text-slate-400">{lowLabel}</span>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            data-testid={`${testPrefix}-${score}`}
            aria-label={`${name}: ${score}`}
            aria-pressed={value === score}
            onClick={() => onPick(score)}
            className={`h-8 w-8 rounded-full border text-xs ${
              value === score
                ? "border-brand-500 bg-brand-100 font-semibold text-brand-700 dark:bg-brand-900 dark:text-brand-300"
                : "border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
            }`}
          >
            {score}
          </button>
        ))}
      </div>
      <span className="text-xs text-slate-400">{highLabel}</span>
    </fieldset>
  );
}

// The mood domain's ONE form (#4424): one-tap valence and the full daily statement
// share the same state, payload, offline capture and optional write subject. A single
// day is edit mode; several days are the quick logger's dated add surface.
export default function MoodForm({
  days,
  showCalm,
  subjectProfileId,
  dateReach = "tap",
  onDone,
  onCancel,
}: {
  days: readonly MoodFormDay[];
  showCalm: boolean;
  subjectProfileId?: number;
  dateReach?: "tap" | "dated";
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const ledger = useOptimisticLedger<number | null>("mood-valence");
  const [selected, setSelected] = useState(0);
  const initial = days[0]?.mood;
  const [valence, setValence] = useState<number | null>(
    initial?.valence ?? null
  );
  const [energy, setEnergy] = useState<number | null>(initial?.energy ?? null);
  const [anxiety, setAnxiety] = useState<number | null>(
    initial?.anxiety ?? null
  );
  const [factors, setFactors] = useState<string[]>(initial?.factors ?? []);
  const [note, setNote] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const day = days[selected];

  function pickDay(index: number): void {
    if (index === selected) return;
    const mood = days[index]?.mood;
    setSelected(index);
    setValence(mood?.valence ?? null);
    setEnergy(mood?.energy ?? null);
    setAnxiety(mood?.anxiety ?? null);
    setFactors(mood?.factors ?? []);
    setNote(mood?.notes ?? "");
    setError(null);
  }

  function draft(nextValence: number): MoodFormValue {
    return {
      valence: nextValence,
      energy,
      anxiety,
      factors,
      notes: note.trim() || null,
    };
  }

  function payload(target: MoodFormDay, next: MoodFormValue): FormData {
    const fd = new FormData();
    fd.set("date", target.date);
    fd.set("valence", String(next.valence));
    if (next.energy != null) fd.set("energy", String(next.energy));
    if (next.anxiety != null) fd.set("anxiety", String(next.anxiety));
    for (const factor of next.factors) fd.append("factors", factor);
    if (next.notes) fd.set("note", next.notes);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    fd.set("date_reach", dateReach);
    return fd;
  }

  async function queueIfOffline(
    err: unknown,
    target: MoodFormDay,
    next: MoodFormValue
  ): Promise<"not-offline" | "refused" | "queued"> {
    // The queue is stamped to the acting profile and carries no subject. A record-row
    // correction posts its subject and therefore must fail honestly rather than queue
    // a write that could replay onto somebody else.
    if (
      subjectProfileId != null ||
      !shouldQueueOffline(
        typeof navigator === "undefined" ? true : navigator.onLine,
        err
      )
    ) {
      return "not-offline";
    }
    const kept = await enqueue("mood", target.date, {
      valence: next.valence,
      energy: next.energy,
      anxiety: next.anxiety,
      factors: next.factors,
      note: next.notes,
    });
    if (!kept) {
      toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
      return "refused";
    }
    toast("Saved offline — will sync when you reconnect.");
    return "queued";
  }

  function tap(nextValence: number): void {
    setError(null);
    const target = day;
    if (!target) return;
    const next = draft(nextValence);
    void ledger.tap({
      key: `${target.date}:${nextValence}`,
      from: valence,
      optimistic: nextValence,
      commit: setValence,
      write: () => logMood(payload(target, next)),
      settle: (result) => {
        if (!result.ok) {
          setError(result.error);
          return { kind: "rollback" };
        }
        toast(
          `Logged ${moodLabel(nextValence)} · ${moodBackfillLabel(selected)}`
        );
        onDone?.();
        return { kind: "keep" };
      },
      onError: async (err) => {
        const queued = await queueIfOffline(err, target, next);
        if (queued === "queued") {
          onDone?.();
          return { kind: "keep" };
        }
        if (queued === "not-offline")
          setError("Couldn't save that check-in — try again.");
        return undefined;
      },
    });
  }

  async function save(): Promise<void> {
    if (!day || valence == null || busy) return;
    const target = day;
    const next = draft(valence);
    setBusy(true);
    setError(null);
    try {
      const result = await logMood(payload(target, next));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast("Check-in saved.");
      onDone?.();
    } catch (err) {
      const queued = await queueIfOffline(err, target, next);
      if (queued === "queued") onDone?.();
      else if (queued === "not-offline")
        setError("Couldn't save that check-in — try again.");
    } finally {
      setBusy(false);
    }
  }

  function toggleFactor(slug: string): void {
    setFactors((current) =>
      current.includes(slug)
        ? current.filter((factor) => factor !== slug)
        : [...current, slug]
    );
  }

  return (
    <form
      className="space-y-3"
      data-testid="mood-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {days.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {days.map((entry, index) => (
            <button
              key={entry.date}
              type="button"
              data-testid={`quick-mood-day-${index}`}
              data-date={entry.date}
              aria-pressed={index === selected}
              onClick={() => pickDay(index)}
              className={`badge cursor-pointer border ${
                index === selected
                  ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                  : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
              }`}
            >
              {moodBackfillLabel(index)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <MoodValencePicker
          value={valence}
          onChange={tap}
          disabled={busy}
          testIdPrefix="quick-mood-tap"
        />
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="quick-mood-status"
        >
          {valence != null ? moodLabel(valence) : "Tap to log that day."}
        </span>
      </div>

      <Disclosure data-testid="mood-details">
        <summary className="cursor-pointer text-sm font-medium text-link">
          Details
        </summary>
        <div className="mt-3 space-y-3">
          <ScaleRow
            name="Energy"
            value={energy}
            onPick={(score) =>
              setEnergy((current) => (current === score ? null : score))
            }
            testPrefix="mood-energy"
            lowLabel="drained"
            highLabel="energized"
          />
          {showCalm ? (
            <ScaleRow
              name="Calm"
              value={anxiety == null ? null : anxietyDisplaySlot(anxiety)}
              onPick={(score) => {
                const stored = anxietyStoredValue(score);
                setAnxiety((current) => (current === stored ? null : stored));
              }}
              testPrefix="mood-anxiety"
              lowLabel={ANXIETY_CALM_LOW_LABEL}
              highLabel={ANXIETY_CALM_HIGH_LABEL}
            />
          ) : null}
          <fieldset>
            <legend className="label mb-1">What’s going on?</legend>
            <div className="flex flex-wrap gap-1.5">
              {MOOD_FACTORS.map((factor) => (
                <button
                  key={factor.slug}
                  type="button"
                  aria-pressed={factors.includes(factor.slug)}
                  onClick={() => toggleFactor(factor.slug)}
                  className={`badge cursor-pointer border ${
                    factors.includes(factor.slug)
                      ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                      : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
                  }`}
                >
                  {factor.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="label block">
            Note
            <textarea
              className="input mt-1 min-h-20"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              type="submit"
              disabled={busy || valence == null}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {onCancel ? (
              <button
                className="btn-ghost btn-sm"
                type="button"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </Disclosure>

      {error ? (
        <p className="text-xs text-rose-600" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
