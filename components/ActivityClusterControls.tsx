"use client";

import { useMemo, useState, useTransition } from "react";
import type { UnitPrefs } from "@/lib/settings";
import {
  detectClusterFieldConflicts,
  type OverrideChoices,
} from "@/lib/import-review/conflicts";
import MergeConflictDialog from "@/components/MergeConflictDialog";
import DuplicateResolutionActions from "@/components/DuplicateResolutionActions";
import {
  mergeActivityCluster,
  resolveActivityCluster,
} from "@/app/(app)/data/review-actions";

export interface ClusterMemberView {
  id: number;
  sourceLabel: string;
  title: string;
  facts: string[];
  foldValues: Record<string, unknown>;
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
  const [pickerOpen, setPickerOpen] = useState(false);

  const conflicts = useMemo(
    () =>
      detectClusterFieldConflicts(
        members.map((m) => ({ id: m.id, values: m.foldValues }))
      ),
    [members]
  );
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
                    <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-ink-800 dark:text-slate-300">
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
      <DuplicateResolutionActions
        pending={pending}
        actions={[
          ["cluster-keeper", members.length, onMergeClick],
          ["keep-all", null, () => submitResolve("kept-both")],
          ["dismiss", null, () => submitResolve("dismissed")],
        ]}
      />

      {pickerOpen && (
        <MergeConflictDialog
          key={keeperId}
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
