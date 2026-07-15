"use client";

import type { ActivityType } from "@/lib/types";
import { titleCase } from "@/lib/activity-meta";
import { chipCls, blockedRing, type PartFault } from "./model";

// Cardio/Sport chips for a committed custom (free-text) activity. Rendered
// whenever the part is custom — even after inference guessed a type — so a
// wrong guess is one tap to fix. While the type is still missing, the amber
// ring marks these chips as what auto-save is waiting on.
export default function CustomTypeChips({
  activeType,
  fault,
  onPick,
}: {
  activeType: ActivityType | null;
  fault: PartFault;
  onPick: (t: "cardio" | "sport") => void;
}) {
  return (
    <div
      className={`mt-2 flex flex-wrap items-center gap-1.5 ${
        fault === "type"
          ? `-mx-1.5 -my-1 rounded-lg px-1.5 py-1 ${blockedRing}`
          : ""
      }`}
    >
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
        New activity:
      </span>
      {(["cardio", "sport"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onPick(t)}
          className={chipCls(activeType === t)}
        >
          {titleCase(t)}
        </button>
      ))}
    </div>
  );
}
