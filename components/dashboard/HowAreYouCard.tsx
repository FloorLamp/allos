"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { shouldQueueOffline } from "@/lib/offline/queue";
import { activateIllnessForSymptoms } from "@/app/(app)/symptoms/actions";
import { logMood } from "@/app/(app)/mood/actions";
import { MOOD_FACES, MOOD_LABELS, MOOD_FACTORS } from "@/lib/mood";

// The unified daily check-in card (issue #992): ONE "How are you today?" shell
// that composes TWO separate engines — the lightweight mood tap (this issue) and
// the illness front door (#843's FeelingSickCard, folded in here) — without
// blurring their contracts. Mood keeps its no-gamification / never-flagged /
// calm-observation-only rules; illness keeps its episode machinery; no
// illness-style escalation ever applies to a mood value. States:
//
//   1. No active illness (the common case): leads with the one-tap mood row, with
//      a QUIETER secondary "Not feeling well?" affordance that branches into the
//      illness-episode flow (the same one-tap activation the old card had —
//      explicit tap, never auto-activation, per the #560 bridge discipline).
//   2. Active illness episode: the episode cockpit lives in the illness hero
//      (#858) above the grid, so this card defers to it with a quiet note — and
//      STILL offers the mood tap (mood during illness is useful signal), so the
//      two coexist rather than one hiding the other.
//   3. Extensible: a future subjective sleep-quality or psych check would join
//      this shell as another row, not a new competing card.
//
// One tap logs the day's mood; "More detail" expands energy/anxiety + factor
// chips + a note (the food-log one-tap ethos, #682). Writes go through the ONE
// logMood action → upsertMoodLog core (idempotent per profile+date — a re-tap
// updates today's row), and a tap that fails offline rides the quick-log queue
// exactly like a weigh-in (issue #28), landing on the captured date.

export interface TodayMood {
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
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
  onPick: (n: number) => void;
  testPrefix: string;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-xs text-slate-500 dark:text-slate-400">
        {name}
      </span>
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-400">{lowLabel}</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`${testPrefix}-${n}`}
            aria-pressed={value === n}
            onClick={() => onPick(n)}
            className={`h-7 w-7 rounded-full border text-xs ${
              value === n
                ? "border-brand-500 bg-brand-100 font-semibold text-brand-700 dark:bg-brand-900 dark:text-brand-300"
                : "border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
            }`}
          >
            {n}
          </button>
        ))}
        <span className="text-xs text-slate-400">{highLabel}</span>
      </div>
    </div>
  );
}

export default function HowAreYouCard({
  date,
  mood,
  activeEpisode,
}: {
  // The profile-local capture date — a queued offline tap lands on THIS day.
  date: string;
  // Today's already-logged check-in (null when unlogged). The upsert is per-day,
  // so a re-tap updates it.
  mood: TodayMood | null;
  // Whether the acting profile has an open illness episode (the hero is up).
  activeEpisode: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();
  const [pending, start] = useTransition();
  const [sickPending, startSick] = useTransition();
  const [expanded, setExpanded] = useState(false);

  // Local mirrors of today's entry for instant feedback; the server row is the
  // source of truth on the next render (router.refresh after each save).
  const [valence, setValence] = useState<number | null>(mood?.valence ?? null);
  const [energy, setEnergy] = useState<number | null>(mood?.energy ?? null);
  const [anxiety, setAnxiety] = useState<number | null>(mood?.anxiety ?? null);
  const [factors, setFactors] = useState<string[]>(mood?.factors ?? []);
  const [note, setNote] = useState(mood?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  // Persist one check-in (tap or expanded save). A bare tap carries the already-
  // stored expand fields along, so re-tapping a face never wipes today's detail.
  function save(next: {
    valence: number;
    energy: number | null;
    anxiety: number | null;
    factors: string[];
    note: string;
  }) {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("date", date);
      fd.set("valence", String(next.valence));
      if (next.energy != null) fd.set("energy", String(next.energy));
      if (next.anxiety != null) fd.set("anxiety", String(next.anxiety));
      for (const f of next.factors) fd.append("factors", f);
      if (next.note.trim()) fd.set("note", next.note.trim());
      try {
        const res = await logMood(fd);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        router.refresh();
      } catch (err) {
        // Offline (or a dropped connection): queue the captured fields to replay
        // on reconnect — idempotent per day, so a double flush can't duplicate.
        if (
          shouldQueueOffline(
            typeof navigator === "undefined" ? true : navigator.onLine,
            err
          )
        ) {
          await enqueue("mood", date, {
            valence: next.valence,
            energy: next.energy,
            anxiety: next.anxiety,
            factors: next.factors,
            note: next.note.trim() ? next.note.trim() : null,
          });
          toast("Saved offline — will sync when you reconnect.");
          return;
        }
        setError("Couldn't save that check-in — try again.");
      }
    });
  }

  function tap(n: number) {
    setValence(n);
    save({ valence: n, energy, anxiety, factors, note });
  }

  function toggleFactor(slug: string) {
    setFactors((prev) =>
      prev.includes(slug) ? prev.filter((f) => f !== slug) : [...prev, slug]
    );
  }

  return (
    <div className="card" data-testid="how-are-you-card">
      <WidgetHeader title="How are you today?" href="/trends?tab=body" />

      {/* The one-tap mood row — the everyday default action. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Mood">
          {MOOD_FACES.map((face, i) => {
            const n = i + 1;
            const selected = valence === n;
            return (
              <button
                key={n}
                type="button"
                data-testid={`mood-tap-${n}`}
                aria-pressed={selected}
                aria-label={`Mood: ${MOOD_LABELS[i]}`}
                title={MOOD_LABELS[i]}
                disabled={pending}
                onClick={() => tap(n)}
                className={`flex h-9 w-9 items-center justify-center rounded-full border text-lg transition ${
                  selected
                    ? "border-brand-500 bg-brand-50 dark:bg-brand-950"
                    : "border-transparent opacity-60 hover:opacity-100"
                } disabled:opacity-40`}
              >
                {face}
              </button>
            );
          })}
        </div>
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="mood-status"
        >
          {valence != null
            ? `Logged: ${MOOD_LABELS[valence - 1]}`
            : "Tap to log your day."}
        </span>
        <button
          type="button"
          data-testid="mood-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="ml-auto text-xs text-brand-600 hover:underline dark:text-brand-400"
        >
          {expanded ? "Less" : "More detail"}
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-2" data-testid="mood-detail">
          <ScaleRow
            name="Energy"
            value={energy}
            onPick={(n) => setEnergy((prev) => (prev === n ? null : n))}
            testPrefix="mood-energy"
            lowLabel="drained"
            highLabel="energized"
          />
          <ScaleRow
            name="Calm"
            value={anxiety}
            onPick={(n) => setAnxiety((prev) => (prev === n ? null : n))}
            testPrefix="mood-anxiety"
            lowLabel="calm"
            highLabel="anxious"
          />
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-16 text-xs text-slate-500 dark:text-slate-400">
              Factors
            </span>
            {MOOD_FACTORS.map((f) => (
              <button
                key={f.slug}
                type="button"
                data-testid={`mood-factor-${f.slug}`}
                aria-pressed={factors.includes(f.slug)}
                onClick={() => toggleFactor(f.slug)}
                className={`badge cursor-pointer border ${
                  factors.includes(f.slug)
                    ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                    : "border-slate-300 bg-transparent text-slate-500 dark:border-slate-600 dark:text-slate-400"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              data-testid="mood-note"
              className="input flex-1 text-sm"
              maxLength={500}
            />
            <button
              type="button"
              data-testid="mood-save"
              disabled={pending || valence == null}
              onClick={() =>
                valence != null &&
                save({ valence, energy, anxiety, factors, note })
              }
              className="btn btn-sm"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-rose-600" data-testid="mood-error">
          {error}
        </p>
      ) : null}

      {/* The illness branch — a separate engine behind the shared shell. */}
      {activeEpisode ? (
        <p
          className="mt-3 border-t border-black/5 pt-2 text-xs text-slate-500 dark:border-white/5 dark:text-slate-400"
          data-testid="mood-episode-note"
        >
          Illness episode active — symptoms and temperature are tracked above.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-black/5 pt-2 dark:border-white/5">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Not feeling well? Start tracking symptoms and temperature.
          </p>
          <button
            type="button"
            data-testid="feeling-sick-activate"
            disabled={sickPending}
            onClick={() =>
              startSick(async () => {
                await activateIllnessForSymptoms();
                router.refresh();
              })
            }
            className="badge cursor-pointer border border-dashed border-brand-400 bg-transparent text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
          >
            {sickPending ? "Starting…" : "I'm feeling sick"}
          </button>
        </div>
      )}
    </div>
  );
}
