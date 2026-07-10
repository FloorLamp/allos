"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { IconGitMerge } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import { fmtDistance, fmtKmh } from "@/lib/units";
import {
  foldFieldLabel,
  type FieldConflict,
} from "@/lib/import-review/conflicts";
import type { ActivityFoldField } from "@/lib/import-review/detect";

// Conflict-aware merge preview (issue #100). Shown ONLY when a merge's two rows
// genuinely disagree on one or more numeric fields; the zero-conflict case never
// mounts this (the caller merges in one click). Lists just the conflicting fields as
// two-option toggles — the keeper's value pre-selected, each option labeled with its
// provenance — and returns the fields the user flipped to the discarded row's value.
// Shared by both merge surfaces (the Journal card menu and the Data → Review
// resolver) so they get the identical preview.

// Format a raw canonical fold value for display in the viewer's units. Distance is
// km→user-unit; speeds are km/h→user-unit; the rest carry a fixed unit suffix.
function formatValue(
  field: ActivityFoldField,
  value: number,
  units: UnitPrefs
): string {
  switch (field) {
    case "distance_km":
      return fmtDistance(value, units.distanceUnit);
    case "avg_speed_kmh":
    case "max_speed_kmh":
      return fmtKmh(value, units.distanceUnit);
    case "duration_min":
      return `${value} min`;
    case "avg_hr":
    case "max_hr":
      return `${value} bpm`;
    case "elevation_m":
      return `${value} m`;
    case "avg_power_w":
    case "max_power_w":
    case "weighted_avg_power_w":
      return `${value} W`;
    case "avg_cadence":
      return `${value} rpm`;
    case "kilojoules":
      return `${value} kJ`;
    case "avg_temp_c":
      return `${value}°C`;
    default:
      return String(value);
  }
}

function OptionButton({
  label,
  value,
  provenance,
  selected,
  onSelect,
  testid,
}: {
  label: string;
  value: string;
  provenance: string;
  selected: boolean;
  onSelect: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      data-testid={testid}
      onClick={onSelect}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
        selected
          ? "border-brand-400 bg-brand-50 ring-1 ring-brand-300 dark:border-brand-600 dark:bg-brand-950/30 dark:ring-brand-700"
          : "border-black/10 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-ink-800"
      }`}
    >
      <div className="font-medium tabular-nums text-slate-800 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {provenance}
      </div>
    </button>
  );
}

export default function MergeConflictDialog({
  conflicts,
  keeperLabel,
  dropLabel,
  units,
  busy = false,
  onConfirm,
  onCancel,
}: {
  conflicts: FieldConflict[];
  // Provenance label for the keeper's values (pre-selected side).
  keeperLabel: string;
  // Provenance label for the row being absorbed (the override side).
  dropLabel: string;
  units: UnitPrefs;
  busy?: boolean;
  // Called with the fold-field NAMES the user flipped to the discarded row's value.
  onConfirm: (overrideFields: string[]) => void;
  onCancel: () => void;
}) {
  // Per-field choice: false = keep the keeper's value (default), true = take the
  // discarded row's value. Only "true" fields become overrides.
  const [takeDrop, setTakeDrop] = useState<
    Partial<Record<ActivityFoldField, boolean>>
  >({});

  function confirm() {
    const overrideFields = conflicts
      .map((c) => c.field)
      .filter((f) => takeDrop[f]);
    onConfirm(overrideFields);
  }

  // Portal to <body> (matching ModalShell/ConfirmDialog): rendered inline inside
  // a journal card, an ancestor stacking context traps the overlay's z-index and
  // later cards paint over the dialog — the confirm button was literally
  // unclickable behind a sibling card (caught by the #100 e2e).
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve merge conflicts"
      data-testid="merge-conflict-dialog"
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={busy ? undefined : onCancel}
      />
      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-4 shadow-xl dark:bg-ink-900">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          These records disagree
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Both rows have a value for{" "}
          {conflicts.length === 1 ? "a field" : "some fields"}. Pick which to
          keep — everything else folds together automatically.
        </p>

        <ul className="mt-3 space-y-3">
          {conflicts.map((c) => {
            const chosenDrop = !!takeDrop[c.field];
            return (
              <li key={c.field} data-testid={`conflict-${c.field}`}>
                <div className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                  {foldFieldLabel(c.field)}
                </div>
                <div
                  role="radiogroup"
                  aria-label={foldFieldLabel(c.field)}
                  className="flex gap-2"
                >
                  <OptionButton
                    label={`Keep ${foldFieldLabel(c.field)} from ${keeperLabel}`}
                    value={formatValue(c.field, c.keepValue, units)}
                    provenance={keeperLabel}
                    selected={!chosenDrop}
                    onSelect={() =>
                      setTakeDrop((s) => ({ ...s, [c.field]: false }))
                    }
                    testid={`conflict-${c.field}-keep`}
                  />
                  <OptionButton
                    label={`Use ${foldFieldLabel(c.field)} from ${dropLabel}`}
                    value={formatValue(c.field, c.dropValue, units)}
                    provenance={dropLabel}
                    selected={chosenDrop}
                    onSelect={() =>
                      setTakeDrop((s) => ({ ...s, [c.field]: true }))
                    }
                    testid={`conflict-${c.field}-drop`}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            data-testid="merge-conflict-confirm"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            <IconGitMerge className="h-4 w-4" stroke={1.75} />
            Merge
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
