"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { IconX, IconMedal2 } from "@tabler/icons-react";
import { standardFor } from "@/lib/strength";
import type { Sex } from "@/lib/types";
import StrengthStandards from "./StrengthStandards";

// A strength "Level" label that opens the standards reference (modal) on click,
// highlighting the row for `exercise` and the cell for this level. A medal icon
// signals the level (and that it's tappable) in place of an underline.
export default function LevelBadge({
  label,
  color,
  exercise,
  className,
  sex,
}: {
  label: string;
  color?: string;
  exercise?: string;
  className?: string;
  sex?: Sex | null;
}) {
  const [open, setOpen] = useState(false);
  const std = exercise ? standardFor(exercise, sex) : undefined;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation(); // don't trigger an enclosing row's onClick
          setOpen(true);
        }}
        title="See strength standards"
        className={`inline-flex items-center gap-1 text-sm font-semibold transition hover:opacity-70 ${
          color ?? ""
        } ${className ?? ""}`}
      >
        <IconMedal2 className="h-4 w-4" />
        {label}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8 dark:bg-black/70"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-xl bg-white p-4 shadow-xl sm:p-5 dark:bg-ink-900"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  Strength standards
                </h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="shrink-0 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                >
                  <IconX className="h-5 w-5" />
                </button>
              </div>
              <p className="mb-3 mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                What the per-exercise “Level” labels mean.
              </p>
              <StrengthStandards
                highlightStandard={std}
                highlightLevel={label}
                sex={sex}
              />
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
