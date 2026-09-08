"use client";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";

import { useMemo, useState } from "react";
import { IconCheck } from "@tabler/icons-react";
import type { MobilityMove } from "@/lib/mobility-moves";
import { regionsForMove } from "@/lib/mobility-coverage";
import type { MuscleRegion } from "@/lib/lifts";
import { useToast } from "@/components/Toast";
import Chip from "@/components/Chip";
import { useWritePipeline } from "@/components/useWritePipeline";
import {
  logMobilityMove,
  unlogMobilityMove,
  setMobilityDuration,
} from "./mobility-actions";

// Mobility taps toggle membership in the day's session. The pipeline reconciles
// with the server's move list and can queue additions; removals require a connection.
// Group moves head-to-toe by their primary region.

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
  // Which surface this mobility bar is on (#3087).
  const stampLoggedVia = useLoggedViaStamp();
  const [duration, setDuration] = useState(
    initialDurationMin != null ? String(initialDurationMin) : ""
  );
  const toast = useToast();
  const pipeline = useWritePipeline<"mobility-move", Set<string>>(
    "mobility-move"
  );

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
    const optimistic = new Set(selected);
    if (wasOn) optimistic.delete(slug);
    else optimistic.add(slug);
    await pipeline.run({
      key: `${slug}:${wasOn ? "off" : "on"}`,
      fields: { move: slug, date: today },
      action: wasOn ? unlogMobilityMove : logMobilityMove,
      optimistic: {
        key: today,
        from: selected,
        to: optimistic,
        commit: setSelected,
      },
      settle: (res) =>
        res.ok
          ? {
              wrote: true,
              value: new Set(res.session.moves),
              announce: "silent",
            }
          : {
              wrote: false,
              announce: {
                message: res.error || "Couldn't save that move — try again.",
                tone: "error",
                undo: null,
              },
            },
      offline: () =>
        wasOn
          ? {
              kind: "refuse",
              message: "You're offline — removing a move needs a connection.",
            }
          : {
              kind: "capture",
              flow: "mobility",
              date: today,
              payload: { move: slug },
              keptMessage: "Saved offline — will sync when you reconnect.",
            },
      failureMessage: "Couldn't save that move — try again.",
    });
  }

  async function saveDuration(raw: string) {
    const fd = stampLoggedVia(new FormData());
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
                  <Chip
                    key={m.slug}
                    role="filter"
                    pressed={on}
                    testId={`mobility-move-${m.slug}`}
                    onClick={() => toggle(m.slug)}
                  >
                    {on && <IconCheck className="h-3.5 w-3.5" stroke={2.5} />}
                    {m.name}
                  </Chip>
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
