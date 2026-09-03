"use client";

import { IconMinus, IconPlus } from "@tabler/icons-react";
import RollingNumber from "@/components/RollingNumber";

// THE FOOD DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.food.pieces.rowControl` — the serving stepper every food-group row
// carries: the tap that logs one serving, and the micro-correction that takes the last
// one back. A full-statement edit is not here; that opens `FoodServingForm` in edit
// mode, which is what the record row's and the day ledger's ⋯ both now do.
//
// IT WAS ALREADY ONE IMPLEMENTATION AND HAD NO IDENTITY — inline markup two thirds of
// the way down a 2,300-line page component, so the manifest had nothing to name and no
// neighbour could mount it without copying it. Its siblings (`DoseStatusControl`,
// `StoolTypeControl`, `SubstanceUnitControl`) are all components; this was the one that
// was not.
//
// NO MINUS AT ZERO (#3987): a permanently disabled control is chrome that says nothing,
// on the row people tap most. The 32px box is kept for the ones that do render —
// `.tap-target` adds a fixed 12px, so the 44px floor (#3486/#3514) is reached from 32px.
//
// AND THIS IS NOT `components/Stepper` (#4542's sixth site, decided here so the next
// sweep reads it at the site rather than in a commit message). A stepper's middle is a
// PENDING value its buttons edit and something else commits; this pair commits on every
// tap — `onBump` runs a Server Action through an optimistic ledger with rollback, an
// offline queue and an Undo toast — and the middle is a `RollingNumber` reading of the
// total already written. So "−" is not "one less", it is "take the last one back", which
// is what both labels say. The chrome follows from that and would have to be argued back
// out of the primitive: no control box at all (this renders a fragment into the row's own
// flex), an asymmetric pair rather than one button style (a ghost minus beside the page's
// primary brand-filled chip, which also carries the settle animation), tabler glyphs
// rather than the primitive's text pair, `h-8` round with `.tap-target` rather than
// `h-11`/`sm:h-9 w-7`, and a minus that is ABSENT below one rather than disabled. Adopting
// it would need a variant or mode prop, which is the outcome #4542 rules out by name.
// `ProteinQuickAdd` is the same shape with a per-tap magnitude field in place of the
// reading; `RpeStepper` is a real stepper still waiting on #4505.

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
