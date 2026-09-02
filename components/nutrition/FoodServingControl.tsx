"use client";

import { IconMinus, IconPlus } from "@tabler/icons-react";
import RollingNumber from "@/components/RollingNumber";

// THE FOOD DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.food.pieces.rowControl` — the serving stepper every food-group row
// carries: the tap that logs one serving, and the micro-correction that takes the last
// one back. A full-statement edit is not here; that opens `FoodServingForm` in edit
// mode, which is what the record row's and the day ledger's ⋯ both now do.
//
// IT WAS ALREADY ONE IMPLEMENTATION AND HAD NO IDENTITY, which is the shape stool's leg
// met from the other side: the control was inline markup two thirds of the way down a
// 2,300-line page component, so the manifest had nothing to name and no neighbour could
// mount it without copying it. Its siblings — `DoseStatusControl`, `StoolTypeControl`,
// `SubstanceUnitControl` — are all components, and this is the one that was not.
//
// NO MINUS AT ZERO (#3987). A permanently disabled control is chrome that says nothing,
// on the row people tap most; there is nothing to remove until something is logged. The
// 32px box is kept for the ones that do render — `.tap-target` adds a fixed 12px, so the
// 44px floor (#3486/#3514) is reached only from 32px up.

export default function FoodServingControl({
  slug,
  name,
  slot,
  count,
  settling,
  reducedMotion,
  settleClassName,
  onBump,
}: {
  slug: string;
  name: string;
  /** The window a tap files into — named in both labels, because it is the write. */
  slot: string;
  count: number;
  settling: boolean;
  reducedMotion: boolean;
  /** The one-shot settle class for this tap, or "" when motion is off. */
  settleClassName: string;
  onBump: (delta: 1 | -1) => void;
}) {
  return (
    <>
      {count > 0 && (
        <button
          type="button"
          data-testid={`undo-${slug}`}
          aria-label={`Remove a ${name} serving from ${slot}`}
          onClick={() => onBump(-1)}
          className="tap-target flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 dark:hover:bg-ink-800"
        >
          <IconMinus className="h-4 w-4" stroke={2} />
        </button>
      )}
      <span
        data-testid={`count-${slug}`}
        className={`w-5 text-center text-sm font-semibold tabular-nums ${
          count === 0
            ? "text-slate-500 dark:text-slate-400"
            : "text-slate-700 dark:text-slate-200"
        }`}
      >
        <RollingNumber value={count} testId={`rolling-count-${slug}`} />
      </span>
      <button
        type="button"
        data-testid={`log-${slug}`}
        aria-label={`Add a ${name} serving to ${slot}`}
        onClick={() => onBump(1)}
        className="group tap-target flex h-8 w-8 items-center justify-center rounded-full text-white"
      >
        {/* The full-size painted chip inside carries the one-shot settle class. It is
            still the tapped chip people see, while the button keeps focus and its 44px
            effective target throughout. */}
        <span
          data-testid={`food-settle-${slug}`}
          data-motion="settle"
          data-reduced-motion={reducedMotion ? "true" : "false"}
          data-settling={settling ? "true" : "false"}
          className={`flex h-full w-full items-center justify-center rounded-full bg-brand-600 transition group-hover:bg-brand-700${
            settling ? ` ${settleClassName}` : ""
          }`}
        >
          <IconPlus className="h-4 w-4" stroke={2} />
        </span>
      </button>
    </>
  );
}
