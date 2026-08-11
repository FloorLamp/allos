"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { IconGitMerge } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import { fmtDistance, fmtKmh } from "@/lib/units";
import {
  foldFieldLabel,
  defaultOverrideChoices,
  type ClusterFieldConflict,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import type { ActivityFoldField } from "@/lib/import-review/detect";

// Per-field conflict picker for a merge (issue #100, N-way since #1431). Shown ONLY
// when the merge's rows genuinely disagree on one or more numeric fields; the
// zero-conflict case never mounts this (the caller merges in one click). Lists each
// conflicting field as a radio across EVERY member's value — the keeper's value
// pre-selected — and returns an explicit per-field member choice, so what renders
// selected is exactly what the merge writes. THE one picker for all merge surfaces
// (the Training Log card menu's quick pick and multi-select, the Data → Review pair card,
// and the Review cluster card) so they can never drift.

// One merge member as the picker sees it: its row id plus the label its value
// options carry (provenance, title, or the caller's disambiguated label).
export interface ConflictDialogMember {
  id: number;
  label: string;
}

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
      className={`min-w-32 flex-1 rounded-lg border px-3 py-2 text-left transition ${
        selected
          ? "border-brand-400 bg-brand-50 ring-1 ring-brand-300 dark:border-brand-600 dark:bg-brand-950/30 dark:ring-brand-700"
          : "border-black/10 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-ink-800"
      }`}
    >
      <div className="font-medium tabular-nums text-slate-800 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
        {provenance}
      </div>
    </button>
  );
}

export default function MergeConflictDialog({
  conflicts,
  members,
  keeperId,
  units,
  movedSetCount = 0,
  busy = false,
  onConfirm,
  onCancel,
}: {
  conflicts: ClusterFieldConflict[];
  // Every merge member (keeper included), for the option labels.
  members: ConflictDialogMember[];
  // The chosen keeper — its values pre-select; a keeper change re-orients the
  // pre-selection (the untouched picks follow the new keeper).
  keeperId: number;
  units: UnitPrefs;
  // How many exercise sets the absorbed rows carry — moved onto the keeper by the
  // merge (#199). Shown so the user sees the training history that will move; 0
  // hides the line.
  movedSetCount?: number;
  busy?: boolean;
  // Called with an explicit per-field member choice for EVERY listed conflict
  // (fold-field name → chosen member's row id) — the selected state verbatim.
  onConfirm: (choices: OverrideChoices) => void;
  onCancel: () => void;
}) {
  // Per-field selection, seeded from the keeper (defaultOverrideChoices — the same
  // computation the merge default follows). Callers key the dialog by keeper id, so
  // a re-oriented preview remounts with the NEW keeper's values pre-selected.
  const [choices, setChoices] = useState<OverrideChoices>(() =>
    defaultOverrideChoices(conflicts, keeperId)
  );

  const labelById = new Map(members.map((m) => [m.id, m.label]));

  // Stable option test ids: `-keep` marks the keeper's value; the lone non-keeper
  // option of a pairwise dialog keeps the shipped `-drop` hook (#100); an N-way
  // dialog needs per-member ids.
  function optionTestid(field: ActivityFoldField, memberId: number): string {
    if (memberId === keeperId) return `conflict-${field}-keep`;
    if (members.length === 2) return `conflict-${field}-drop`;
    return `conflict-${field}-from-${memberId}`;
  }

  // Portal to <body> (matching ModalShell/ConfirmDialog): rendered inline inside
  // a training log card, an ancestor stacking context traps the overlay's z-index and
  // later cards paint over the dialog — the confirm button was literally
  // unclickable behind a sibling card (caught by the #100 e2e).
  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4"
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
          More than one record has a value for{" "}
          {conflicts.length === 1 ? "a field" : "some fields"}. Pick which to
          keep — everything else folds together automatically.
        </p>

        {movedSetCount > 0 && (
          <p
            className="mt-2 text-sm text-slate-500 dark:text-slate-400"
            data-testid="merge-set-count"
          >
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {movedSetCount} logged set{movedSetCount === 1 ? "" : "s"}
            </span>{" "}
            will move to the kept activity.
          </p>
        )}

        <ul className="mt-3 space-y-3">
          {conflicts.map((c) => (
            <li key={c.field} data-testid={`conflict-${c.field}`}>
              <div className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
                {foldFieldLabel(c.field)}
              </div>
              <div
                role="radiogroup"
                aria-label={foldFieldLabel(c.field)}
                className="flex flex-wrap gap-2"
              >
                {c.options.map((o) => {
                  const label = labelById.get(o.memberId) ?? "Unknown";
                  const isKeeper = o.memberId === keeperId;
                  return (
                    <OptionButton
                      key={o.memberId}
                      label={`${isKeeper ? "Keep" : "Use"} ${foldFieldLabel(c.field)} from ${label}`}
                      value={formatValue(c.field, o.value, units)}
                      provenance={label}
                      selected={choices[c.field] === o.memberId}
                      onSelect={() =>
                        setChoices((s) => ({ ...s, [c.field]: o.memberId }))
                      }
                      testid={optionTestid(c.field, o.memberId)}
                    />
                  );
                })}
              </div>
            </li>
          ))}
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
            onClick={() => onConfirm(choices)}
            disabled={busy}
            data-testid="merge-conflict-confirm"
            className="btn btn-sm"
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
