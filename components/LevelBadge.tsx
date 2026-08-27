"use client";

import { useState } from "react";
import { IconMedal2 } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import {
  strengthLevelLabel,
  strengthLevelColor,
  type StrengthLevel,
} from "@/lib/strength-standards";
import type { Sex } from "@/lib/types";
import StrengthStandards from "./StrengthStandards";

// A strength "Level" label that opens the standards reference (modal) on click,
// highlighting the row for `exercise` and the cell for this level. The label and
// color come from the single strength-standard model (lib/strength-standards),
// the SAME computation that placed the lifter — so the badge can never disagree
// with the coaching line or benchmark card. A medal icon signals the level (and
// that it's tappable) in place of an underline.
//
// IT RENDERS THROUGH THE SHARED HOST (#3445). It used to hand-roll the whole
// dialog: its own `createPortal`, its own `fixed inset-0` scrim, its own centred
// card, its own heading and ✕. That copy carried no `role`, no `aria-modal`, no
// focus trap, no Escape and no body lock — so it was a dialog a screen reader was
// never told about, and the page scrolled behind it. It was also INVISIBLE to the
// dialog census for exactly the same reason it was inaccessible: the census asked
// whether a file spelled `role="dialog"`, and this one did not. Both halves are
// answered by rendering the host, which is the default (docs/internals/overlays.md).
//
// Analyze renders the badge as the compact current-tier answer. Its Benchmarks
// ladder shows the placement in context without repeating a second tier headline.
export default function LevelBadge({
  level,
  exercise,
  sex,
  bodyweightKg,
}: {
  level: StrengthLevel;
  exercise: string;
  sex: Sex | null;
  // The lifter's bodyweight, so the reference table shows floors adjusted for it.
  bodyweightKg: number | null;
}) {
  const [open, setOpen] = useState(false);
  const label = strengthLevelLabel(level);
  const color = strengthLevelColor(level);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`tap-target inline-flex min-h-8 items-center gap-1 text-sm font-semibold transition hover:opacity-70 ${color}`}
      >
        <IconMedal2 className="h-4 w-4" />
        {label}
        <span className="sr-only"> — see strength standards</span>
      </button>

      {open && (
        <ModalShell
          title="Strength standards"
          onClose={() => setOpen(false)}
          // The reference is a TABLE, and the hand-rolled card was `max-w-lg`.
          // `md` (`sm:max-w-2xl`) is the nearest declared size upward; `lg` is
          // for the multi-column tools and would leave this one mostly gutter.
          size="md"
          testId="strength-standards-modal"
        >
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            What the per-exercise “Level” labels mean.
          </p>
          <StrengthStandards
            highlightLift={exercise}
            highlightLevel={level}
            sex={sex}
            bodyweightKg={bodyweightKg}
          />
        </ModalShell>
      )}
    </>
  );
}
