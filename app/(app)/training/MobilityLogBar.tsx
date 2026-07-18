"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconCheck } from "@tabler/icons-react";
import type { MobilityMove } from "@/lib/mobility-moves";
import { regionsForMove } from "@/lib/mobility-coverage";
import type { MuscleRegion } from "@/lib/lifts";
import { useToast } from "@/components/Toast";
import {
  logMobilityMove,
  unlogMobilityMove,
  setMobilityDuration,
} from "./mobility-actions";

// One-tap mobility logger (issue #840), the movement analog of the FoodLogBar. A move is
// a TOGGLE — present or absent in today's session, never a count (no per-move sets/weights,
// the habit-tier "one move = one tap" model). Toggling reconciles its optimistic selection
// with the server's authoritative session move list (the food-log #748 item 2 pattern).
// Moves are grouped head-to-toe by their primary region so the bar reads like a routine.

const REGION_ORDER: MuscleRegion[] = [
  "Shoulders",
  "Back",
  "Arms",
  "Chest",
  "Core",
  "Glutes",
  "Legs",
];

// The section a move sorts into: the region of its FIRST tagged muscle (its primary
// emphasis), so each move appears once. Falls back to "Legs" for an untagged move.
function primaryRegion(move: MobilityMove): MuscleRegion {
  return regionsForMove(move.slug)[0] ?? "Legs";
}

export default function MobilityLogBar({
  today,
  initialMoves,
  initialDurationMin,
  moves,
}: {
  today: string; // the acting profile's today (YYYY-MM-DD)
  initialMoves: string[]; // move slugs logged in today's session
  initialDurationMin: number | null;
  moves: MobilityMove[]; // the full catalog, in file order
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialMoves)
  );
  const [duration, setDuration] = useState(
    initialDurationMin != null ? String(initialDurationMin) : ""
  );
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const sections = useMemo(() => {
    const byRegion = new Map<MuscleRegion, MobilityMove[]>();
    for (const m of moves) {
      const r = primaryRegion(m);
      const list = byRegion.get(r) ?? [];
      list.push(m);
      byRegion.set(r, list);
    }
    return REGION_ORDER.filter((r) => byRegion.has(r)).map((r) => ({
      region: r,
      moves: byRegion.get(r)!,
    }));
  }, [moves]);

  async function toggle(slug: string) {
    const wasOn = selected.has(slug);
    // Optimistic flip.
    setSelected((prev) => {
      const next = new Set(prev);
      if (wasOn) next.delete(slug);
      else next.add(slug);
      return next;
    });
    const fd = new FormData();
    fd.set("move", slug);
    fd.set("date", today);
    const res = wasOn
      ? await unlogMobilityMove(fd)
      : await logMobilityMove(fd);
    if (res.ok) {
      // Reconcile with the server's authoritative move list.
      setSelected(new Set(res.session.moves));
    } else {
      // Roll back and warn.
      setSelected((prev) => {
        const next = new Set(prev);
        if (wasOn) next.add(slug);
        else next.delete(slug);
        return next;
      });
      toast(res.error || "Couldn't save that move — try again.", {
        tone: "error",
      });
    }
    startTransition(() => router.refresh());
  }

  async function saveDuration(raw: string) {
    const fd = new FormData();
    fd.set("date", today);
    fd.set("minutes", raw.trim());
    const res = await setMobilityDuration(fd);
    if (res.ok) {
      setDuration(
        res.session.durationMin != null ? String(res.session.durationMin) : ""
      );
    } else {
      toast(res.error || "Couldn't save the duration.", { tone: "error" });
    }
    startTransition(() => router.refresh());
  }

  const count = selected.size;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log mobility
        </h2>
        <span
          data-testid="mobility-move-total"
          className="shrink-0 text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
        >
          {count} {count === 1 ? "move" : "moves"} today
        </span>
      </div>
      <div data-testid="mobility-log-bar" className="space-y-4">
        {sections.map(({ region, moves: regionMoves }) => (
          <div key={region}>
            <h3 className="mb-2 section-label">{region}</h3>
            <div className="flex flex-wrap gap-2">
              {regionMoves.map((m) => {
                const on = selected.has(m.slug);
                return (
                  <button
                    key={m.slug}
                    type="button"
                    data-testid={`mobility-move-${m.slug}`}
                    aria-pressed={on}
                    title={m.description}
                    onClick={() => toggle(m.slug)}
                    className={`tap-target inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                      on
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-black/10 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-ink-900 dark:text-slate-200 dark:hover:bg-ink-800"
                    }`}
                  >
                    {on && <IconCheck className="h-3.5 w-3.5" stroke={2.5} />}
                    {m.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <label
          htmlFor="mobility-duration"
          className="text-sm text-slate-500 dark:text-slate-400"
        >
          Duration (optional)
        </label>
        <input
          id="mobility-duration"
          data-testid="mobility-duration"
          type="number"
          inputMode="numeric"
          min={0}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onBlur={(e) => saveDuration(e.target.value)}
          className="input w-20"
          placeholder="min"
        />
        <span className="text-sm text-slate-500 dark:text-slate-400">min</span>
      </div>
    </div>
  );
}
