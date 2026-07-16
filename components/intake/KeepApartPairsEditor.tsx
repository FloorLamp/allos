"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconX } from "@tabler/icons-react";
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
    <div className="sm:col-span-2">
      <label className="label">Interactions</label>
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
                <option value="separate">keep apart from</option>
                <option value="with">take together with</option>
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
                placeholder="note (optional)"
                aria-label="Note"
              />
              <button
                type="button"
                onClick={() =>
                  setPairRows((ps) => ps.filter((_, j) => j !== i))
                }
                className="tap-target flex h-8 w-8 items-center justify-center justify-self-end rounded text-slate-300 hover:text-rose-500 dark:text-slate-600 dark:hover:text-rose-400"
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
        className="mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        + Add interaction
      </button>
    </div>
  );
}
