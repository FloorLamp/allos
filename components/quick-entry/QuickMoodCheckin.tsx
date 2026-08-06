"use client";

import { useState } from "react";
import MoodValencePicker from "@/components/MoodValencePicker";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { logMood } from "@/app/(app)/mood-actions";
import { moodBackfillLabel, moodLabel } from "@/lib/mood";

// The quick-entry overlay's mood check-in (#2130) — the sheet's "Log mood" row.
//
// NOT a second write path: it renders the SAME MoodValencePicker over the SAME
// `logMood` action (and the same offline capture) the dashboard card runs, with
// the #2128 backfill chips choosing WHICH day the tap logs. Deliberately the
// COMPACT half of the check-in: energy/calm/factors/notes stay on the dashboard
// card's expanded section — a quick logger answers "how are you", and the day's
// row remains re-tappable and editable there and in the readings table.
//
// A successful tap closes the sheet (the #1468 contract: a check-in is a
// transaction with a real end, and you land back where you were).

export interface QuickMoodDay {
  date: string;
  mood: {
    valence: number;
    energy: number | null;
    anxiety: number | null;
    factors: string[];
    notes: string | null;
  } | null;
}

export default function QuickMoodCheckin({
  days,
  onDone,
}: {
  // Today first, then the backfill window (server-gathered on open).
  days: QuickMoodDay[];
  onDone: () => void;
}) {
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  // The SAME declared affordance as the dashboard card's face row (#2130): an
  // idempotent per-(profile, date) upsert, keyed per face so a quick correction
  // onto a different face is a new write rather than an absorbed double-tap.
  const ledger = useOptimisticLedger<number | null>("mood-valence");
  const [selected, setSelected] = useState(0);
  const [valence, setValence] = useState<number | null>(
    days[0]?.mood?.valence ?? null
  );
  const [error, setError] = useState<string | null>(null);

  const day = days[selected];

  function pickDay(index: number) {
    if (index === selected) return;
    setSelected(index);
    setValence(days[index]?.mood?.valence ?? null);
    setError(null);
  }

  function tap(n: number) {
    setError(null);
    const target = day;
    if (!target) return;
    const fd = new FormData();
    fd.set("date", target.date);
    fd.set("valence", String(n));
    // Carry the day's already-stored expand fields along, exactly as the card's
    // bare tap does, so a quick re-rate never wipes that day's detail.
    if (target.mood?.energy != null)
      fd.set("energy", String(target.mood.energy));
    if (target.mood?.anxiety != null)
      fd.set("anxiety", String(target.mood.anxiety));
    for (const f of target.mood?.factors ?? []) fd.append("factors", f);
    if (target.mood?.notes) fd.set("note", target.mood.notes);
    void ledger.tap({
      key: `${target.date}:${n}`,
      from: valence,
      optimistic: n,
      commit: setValence,
      write: () => logMood(fd),
      settle: (res) => {
        if (!res.ok) {
          setError(res.error);
          return { kind: "rollback" };
        }
        toast(`Logged ${moodLabel(n)} · ${moodBackfillLabel(selected)}`);
        onDone();
        return { kind: "keep" };
      },
      onError: async (err) => {
        if (
          shouldQueueOffline(
            typeof navigator === "undefined" ? true : navigator.onLine,
            err
          )
        ) {
          await enqueue("mood", target.date, {
            valence: n,
            energy: target.mood?.energy ?? null,
            anxiety: target.mood?.anxiety ?? null,
            factors: target.mood?.factors ?? [],
            note: target.mood?.notes ?? null,
          });
          toast("Saved offline — will sync when you reconnect.");
          onDone();
          return { kind: "keep" };
        }
        setError("Couldn't save that check-in — try again.");
        return undefined; // rollback
      },
    });
  }

  return (
    <div className="space-y-3" data-testid="quick-mood-checkin">
      <div className="flex flex-wrap items-center gap-1.5">
        {days.map((d, i) => (
          <button
            key={d.date}
            type="button"
            data-testid={`quick-mood-day-${i}`}
            aria-pressed={i === selected}
            onClick={() => pickDay(i)}
            className={`badge cursor-pointer border ${
              i === selected
                ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
            }`}
          >
            {moodBackfillLabel(i)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <MoodValencePicker
          value={valence}
          onChange={tap}
          testIdPrefix="quick-mood-tap"
        />
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="quick-mood-status"
        >
          {valence != null ? moodLabel(valence) : "Tap to log that day."}
        </span>
      </div>
      {error ? (
        <p className="text-xs text-rose-600" role="alert">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-slate-400 dark:text-slate-500">
        Energy, calm, and notes live on the dashboard check-in.
      </p>
    </div>
  );
}
