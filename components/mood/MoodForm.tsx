"use client";

import { useEffect, useRef, useState } from "react";
import { logMood } from "@/app/(app)/mood-actions";
import Chip from "@/components/Chip";
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
  moodLabel,
} from "@/lib/mood";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import SubmitButton from "@/components/SubmitButton";

export interface MoodFormValue {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
}

export interface MoodFormDay {
  date: string;
  label: string;
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
// share the same state, payload, offline capture and optional write subject. The
// mounting context declares whether a rating is a quick write or local edit state;
// history add is deliberately a single dated day that remains quick-entry capable.
export default function MoodForm({
  days,
  showCalm,
  dayUnseen = false,
  subjectProfileId,
  dateReach = "tap",
  mode = "quick",
  repeatAfterSave = false,
  onStagedChange,
  onSaved,
  onDone,
  onCancel,
}: {
  days: readonly MoodFormDay[];
  showCalm: boolean;
  // `days` COULD NOT BE READ from the server (#3416) — the quick logger's cold
  // offline open, whose days carry only what this device queued itself. A day the
  // person filled in elsewhere opens empty here, so what this form does not carry is
  // UNKNOWN rather than cleared, and both write paths say so: the write core merges
  // instead of replacing the day's row. Every other mount pre-fills from the stored
  // check-in and leaves this false.
  //
  // FIXED FOR THE LIFE OF THE MOUNT. The fields below are seeded from `days` once,
  // so a mount that composed blind holds blind state until it is replaced; a host
  // that swapped this flag off under it would leave that state writing the replacing
  // statement over a day it still cannot see. The one host that can learn the day
  // mid-sheet remounts this form on it (QuickEntryProvider's body `key`) rather than
  // moving the prop, so the sight the form was composed under is the sight it writes
  // under.
  dayUnseen?: boolean;
  // WHETHER THIS MOUNT IS HOLDING INPUT A REPLACEMENT WOULD DISCARD (#3416), reported
  // while it is mounted and false when it goes. One host replaces this form under the
  // person — the quick sheet, when the day it could not see arrives — and it makes
  // its announcement only when this says there is something to announce. In quick
  // mode the valence tap IS the write, so what is staged is the Details block; in
  // edit mode nothing is written until Save, so the rating is staged too.
  onStagedChange?: (staged: boolean) => void;
  subjectProfileId?: number;
  dateReach?: "tap" | "dated";
  mode?: "quick" | "edit";
  repeatAfterSave?: boolean;
  onSaved?: () => void;
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
  const [entryVersion, setEntryVersion] = useState(0);
  const writing = useRef(false);

  const day = days[selected];

  // WHAT WOULD BE LOST, against the day on screen — the person's own input, not the
  // day's stored answer. A note typed and then deleted back to what was there leaves
  // nothing to lose, and says so.
  const shown = day?.mood ?? null;
  const staged =
    energy !== (shown?.energy ?? null) ||
    anxiety !== (shown?.anxiety ?? null) ||
    (note.trim() || null) !== (shown?.notes ?? null) ||
    factors.length !== (shown?.factors.length ?? 0) ||
    factors.some((slug) => !shown?.factors.includes(slug)) ||
    (mode === "edit" && valence !== (shown?.valence ?? null));
  useEffect(() => {
    onStagedChange?.(staged);
    return () => onStagedChange?.(false);
  }, [staged, onStagedChange]);

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

  function beginWrite(): boolean {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    return true;
  }

  function endWrite(): void {
    writing.current = false;
    setBusy(false);
  }

  function resetEntry(): void {
    setValence(null);
    setEnergy(null);
    setAnxiety(null);
    setFactors([]);
    setNote("");
    setError(null);
    // A second identical rating is a second history entry attempt, not a double tap
    // on the first ledger key. Give each cleared form its own write identity.
    setEntryVersion((current) => current + 1);
  }

  function complete(target: MoodFormDay, nextValence: number): void {
    toast(`Logged ${moodLabel(nextValence)} · ${target.label}`);
    onSaved?.();
    if (repeatAfterSave) resetEntry();
    else onDone?.();
  }

  function payload(target: MoodFormDay, next: MoodFormValue): FormData {
    const fd = new FormData();
    fd.set("date", target.date);
    fd.set("valence", String(next.valence));
    if (next.energy != null) fd.set("energy", String(next.energy));
    if (next.anxiety != null) fd.set("anxiety", String(next.anxiety));
    for (const factor of next.factors) fd.append("factors", factor);
    if (next.notes) fd.set("note", next.notes);
    if (dayUnseen) fd.set("day_unseen", "1");
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
    let outcome: "kept" | "closed" | "failed";
    try {
      outcome = await enqueue("mood", target.date, {
        valence: next.valence,
        energy: next.energy,
        anxiety: next.anxiety,
        factors: next.factors,
        note: next.notes,
        ...(dayUnseen ? { dayUnseen: true as const } : {}),
      });
    } catch {
      outcome = "failed";
    }
    if (outcome !== "kept") {
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
    if (mode === "edit") {
      // A correction is one statement and has one commit point. Its rating is local
      // form state until Save, just like Energy, Calm, factors and the note.
      setValence(nextValence);
      return;
    }
    if (!beginWrite()) return;
    const next = draft(nextValence);
    void ledger
      .tap({
        key: `${target.date}:${nextValence}:${entryVersion}`,
        from: valence,
        optimistic: nextValence,
        commit: setValence,
        write: () => logMood(payload(target, next)),
        settle: (result) => {
          if (!result.ok) {
            setError(result.error);
            return { kind: "rollback" };
          }
          complete(target, nextValence);
          return { kind: "keep" };
        },
        onError: async (err) => {
          const queued = await queueIfOffline(err, target, next);
          if (queued === "queued") {
            complete(target, nextValence);
            return { kind: "keep" };
          }
          if (queued === "not-offline")
            setError("Couldn't save that check-in — try again.");
          return { kind: "rollback" };
        },
      })
      .finally(endWrite);
  }

  async function save(): Promise<void> {
    if (!day || valence == null || !beginWrite()) return;
    const target = day;
    const next = draft(valence);
    setError(null);
    try {
      const result = await logMood(payload(target, next));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      complete(target, valence);
    } catch (err) {
      const queued = await queueIfOffline(err, target, next);
      if (queued === "queued") complete(target, valence);
      else if (queued === "not-offline")
        setError("Couldn't save that check-in — try again.");
    } finally {
      endWrite();
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
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {/* One write snapshots the whole statement and its date. Freeze that whole
          transaction boundary until it settles so the visible draft cannot move
          beyond the payload already in flight or receive a rollback for another day. */}
      <fieldset
        className="min-w-0 space-y-3"
        data-testid="mood-form-controls"
        disabled={busy}
      >
        {days.length > 1 ? (
          // A wrapping strip of box-height chips: `gap-3.5` where the reach exists, so
          // two extended targets on adjacent lines never own the same point (#4035's
          // measurement — `gap-3` against 6px per side lands on exactly zero margin).
          <div className="flex flex-wrap items-center gap-1.5 pointer-coarse:gap-3.5">
            {days.map((entry, index) => (
              <Chip
                key={entry.date}
                role="filter"
                pressed={index === selected}
                testId={`quick-mood-day-${index}`}
                data={{ "data-date": entry.date }}
                onClick={() => pickDay(index)}
              >
                {entry.label}
              </Chip>
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
          <summary className="fold-control text-sm font-medium text-link">
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
              <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-3.5">
                {MOOD_FACTORS.map((factor) => (
                  <Chip
                    key={factor.slug}
                    role="filter"
                    pressed={factors.includes(factor.slug)}
                    onClick={() => toggleFactor(factor.slug)}
                  >
                    {factor.label}
                  </Chip>
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
              <SubmitButton
                variant="primary"
                disabled={busy || valence == null}
              >
                {busy ? "Saving…" : "Save"}
              </SubmitButton>
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
      </fieldset>
    </form>
  );
}
