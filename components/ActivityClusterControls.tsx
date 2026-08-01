"use client";

import { useMemo, useState, useTransition } from "react";
import { IconGitMerge, IconCopyCheck, IconEyeOff } from "@tabler/icons-react";
import type { UnitPrefs } from "@/lib/settings";
import {
  detectClusterFieldConflicts,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import {
  mergeActivityCluster,
  resolveActivityCluster,
} from "@/app/(app)/data/review-actions";

// The N-way cluster card body for Data → Review (issue #1081): a duplicate GROUP of
// 3+ activity rows that pairwise matched, collapsed into ONE card. It lists every
// member with a keeper RADIO (defaulted to preferActivityKeeperId, any member
// selectable), one "Merge N into keeper" button, and cluster-level Keep all / Dismiss.
// Merging folds keeper-wins + gap-fill across all drops through the shared N-way
// core; when the members genuinely disagree on a field, the merge opens the SHARED
// per-field picker (#100/#1431) first — a radio across every member's value,
// pre-selected to the current keeper's — so picking a new keeper and re-opening
// re-orients the preview.
//
// A 2-row cluster renders through the pairwise ActivityMergeControls instead (the
// N=2 case, unchanged); this component is only used for 3+ members.

export interface ClusterMemberView {
  id: number;
  sourceLabel: string;
  title: string;
  facts: string[];
  // The member's fold-field values (pickFoldValues) — the picker's conflict input.
  foldValues: Record<string, unknown>;
  // Ordinal badge shown when two members' source labels collide (#531) — the on-card
  // referent for the keeper radio. Undefined when every label is distinct.
  badge?: string;
}

export default function ActivityClusterControls({
  clusterSignature,
  pairSignatures,
  members,
  defaultKeeperId,
  units,
}: {
  clusterSignature: string;
  pairSignatures: string[];
  members: ClusterMemberView[];
  defaultKeeperId: number;
  units: UnitPrefs;
}) {
  const [keeperId, setKeeperId] = useState(defaultKeeperId);
  const [pending, startTransition] = useTransition();
  // Whether the merge is awaiting per-field conflict resolution in the picker.
  const [pickerOpen, setPickerOpen] = useState(false);

  const conflicts = useMemo(
    () =>
      detectClusterFieldConflicts(
        members.map((m) => ({ id: m.id, values: m.foldValues }))
      ),
    [members]
  );
  // Picker option labels: the member's source label, suffixed with its ordinal
  // badge when labels collide (#531) so every option keeps an on-card referent.
  const dialogMembers = useMemo(
    () =>
      members.map((m) => ({
        id: m.id,
        label: m.badge ? `${m.sourceLabel} ${m.badge}` : m.sourceLabel,
      })),
    [members]
  );

  function submitMerge(choices: OverrideChoices) {
    const dropIds = members.map((m) => m.id).filter((id) => id !== keeperId);
    if (dropIds.length === 0) return;
    const fd = new FormData();
    fd.set("keep_id", String(keeperId));
    fd.set("drop_ids", JSON.stringify(dropIds));
    fd.set("pair_signatures", JSON.stringify(pairSignatures));
    if (Object.keys(choices).length > 0)
      fd.set("overrides", JSON.stringify(choices));
    startTransition(() => {
      void mergeActivityCluster(fd);
    });
  }

  function onMergeClick() {
    if (conflicts.length > 0) {
      setPickerOpen(true);
      return;
    }
    submitMerge({});
  }

  function submitResolve(decision: "kept-both" | "dismissed") {
    const fd = new FormData();
    fd.set("decision", decision);
    fd.set("pair_signatures", JSON.stringify(pairSignatures));
    startTransition(() => {
      void resolveActivityCluster(fd);
    });
  }

  return (
    <div>
      <ul
        className="grid gap-2 sm:grid-cols-2"
        data-testid="dup-cluster-members"
      >
        {members.map((m) => {
          const isKeeper = m.id === keeperId;
          return (
            <li key={m.id}>
              <label
                data-testid="dup-cluster-member"
                className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${
                  isKeeper
                    ? "border-brand-300 bg-brand-50/50 dark:border-brand-800 dark:bg-brand-950/20"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <input
                  type="radio"
                  name={`keeper-${clusterSignature}`}
                  checked={isKeeper}
                  onChange={() => setKeeperId(m.id)}
                  data-testid="dup-cluster-keeper-radio"
                  className="mt-0.5"
                  aria-label={`Keep ${m.title}`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {m.badge && (
                      <span
                        data-testid="dup-candidate-badge"
                        aria-label={`Option ${m.badge}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-xs font-bold text-white dark:bg-slate-200 dark:text-slate-900"
                      >
                        {m.badge}
                      </span>
                    )}
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {m.sourceLabel}
                    </span>
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {m.title}
                    </span>
                    {isKeeper && (
                      <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
                        keeper
                      </span>
                    )}
                  </div>
                  {m.facts.length > 0 && (
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {m.facts.join(" · ")}
                    </div>
                  )}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onMergeClick}
          disabled={pending}
          data-testid="dup-cluster-merge"
          className="btn btn-sm"
        >
          <IconGitMerge className="h-4 w-4" stroke={1.75} />
          Merge {members.length} into keeper
        </button>
        <button
          type="button"
          onClick={() => submitResolve("kept-both")}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
        >
          <IconCopyCheck className="h-4 w-4" stroke={1.75} />
          Keep all
        </button>
        <button
          type="button"
          onClick={() => submitResolve("dismissed")}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-ink-750"
        >
          <IconEyeOff className="h-4 w-4" stroke={1.75} />
          Dismiss
        </button>
      </div>

      {pickerOpen && (
        <MergeConflictDialog
          conflicts={conflicts}
          members={dialogMembers}
          keeperId={keeperId}
          units={units}
          busy={pending}
          onConfirm={(choices) => {
            setPickerOpen(false);
            submitMerge(choices);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
