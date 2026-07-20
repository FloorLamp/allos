"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import type { PairRelation } from "@/lib/types";

// One keep-apart / take-together pair row's client state (shared, #846).
export interface PairState {
  otherId: number;
  relation: PairRelation;
  note: string;
}

// The keep-apart pairs editor shared by both intake forms (#846): user-declared
// "keep apart from" / "take together with" relationships to the profile's other
// tracked items. Renders nothing when there are no other items to pair with.
export default function KeepApartPairsEditor({
  pairRows,
  setPairRows,
  others,
}: {
  pairRows: PairState[];
  setPairRows: Dispatch<SetStateAction<PairState[]>>;
  others: { id: number; name: string }[];
}) {
  if (others.length === 0) return null;

  function setPair(i: number, patch: Partial<PairState>) {
    setPairRows((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  return (
    <div className="border-t border-black/5 pt-4 sm:col-span-2 dark:border-white/5">
      <div className="mb-2 section-label">Timing with other items</div>
      {pairRows.length > 0 && (
        <div className="space-y-2">
          {pairRows.map((p, i) => (
            <div
              key={i}
              className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
            >
              <select
                value={p.relation}
                onChange={(e) =>
                  setPair(i, { relation: e.target.value as PairRelation })
                }
                className="input col-span-2 sm:col-auto sm:w-36"
                aria-label="Relation"
              >
                <option value="separate">Keep apart from</option>
                <option value="with">Take together with</option>
              </select>
              <select
                value={p.otherId || others[0].id}
                onChange={(e) =>
                  setPair(i, { otherId: Number(e.target.value) })
                }
                className="input col-span-2 sm:col-auto sm:w-40"
                aria-label="Other item"
              >
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <input
                value={p.note}
                onChange={(e) => setPair(i, { note: e.target.value })}
                className="input sm:w-40"
                placeholder="Note (optional)"
                aria-label="Note"
              />
              <button
                type="button"
                onClick={() =>
                  setPairRows((ps) => ps.filter((_, j) => j !== i))
                }
                className="tap-target flex h-10 w-10 items-center justify-center justify-self-end rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                aria-label="Remove interaction"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() =>
          setPairRows((ps) => [
            ...ps,
            { otherId: others[0].id, relation: "separate", note: "" },
          ])
        }
        className="btn-ghost btn-sm mt-2"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
        Add interaction
      </button>
    </div>
  );
}
