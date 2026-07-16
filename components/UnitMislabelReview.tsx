"use client";

import { useRouter } from "next/navigation";
import { IconWand, IconEyeOff, IconAlertTriangle } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import {
  applyUnitMislabel,
  undoUnitMislabel,
  dismissUnitMislabel,
} from "@/app/(app)/data/review-actions";
import type { UnitMislabelReview as UnitMislabelReviewRow } from "@/lib/queries/medical";

// Data → Review, unit-mislabel cross-check (issue #761). Each card is a numeric lab
// reading whose stored unit is a probable power-of-ten mislabel of the canonical
// unit — the false flag is ALREADY suppressed on every surface; this is the
// one-click remediation. Apply corrects the stored unit (+ sets the edit-lock, +
// re-derives the flag) and offers an Undo toast; Dismiss records a false positive so
// the card never re-surfaces. A client component so Apply can offer the reversible
// Undo toast (the existing useUndoableDelete pattern, bespoke here since the token is
// the captured prior state, not a deleted-row id).

const UNDO_TOAST_MS = 15000;

// "31-37" → "31–37" for display (en dash between the two bounds).
function prettyRange(s: string): string {
  return s.replace(/\s*-\s*/, "–");
}

export default function UnitMislabelReview({
  items,
}: {
  items: UnitMislabelReviewRow[];
}) {
  const toast = useToast();
  const router = useRouter();

  if (items.length === 0) return null;

  async function onApply(item: UnitMislabelReviewRow) {
    const fd = new FormData();
    fd.set("id", String(item.id));
    const res = await applyUnitMislabel(fd);
    router.refresh();
    if (!res.ok) {
      toast(res.error, { tone: "error" });
      return;
    }
    const undo = res.undo;
    toast(`Unit corrected to ${item.correctedUnit}.`, {
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            const r = await undoUnitMislabel(undo);
            if (r.ok) {
              toast("Correction undone.");
              router.refresh();
            } else {
              toast("Couldn’t undo the correction.", { tone: "error" });
            }
          })();
        },
      },
    });
  }

  async function onDismiss(item: UnitMislabelReviewRow) {
    const fd = new FormData();
    fd.set("id", String(item.id));
    const res = await dismissUnitMislabel(fd);
    router.refresh();
    if (!res.ok) toast(res.error, { tone: "error" });
  }

  return (
    <div className="card" data-testid="unit-mislabel-review">
      <div className="mb-1 flex items-center gap-2">
        <IconAlertTriangle className="h-5 w-5 text-amber-500" stroke={1.75} />
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Possible unit mislabels ({items.length})
        </h2>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        The report&apos;s printed reference range doesn&apos;t match its stated
        unit — the value looks off by a factor of ten. Correcting the unit fixes
        a false out-of-range flag (already hidden until you decide).
      </p>

      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="unit-mislabel-card"
            data-record-id={item.id}
            data-name={item.name}
            className="rounded-lg border border-black/10 p-3 dark:border-white/10"
          >
            <div className="text-sm text-slate-700 dark:text-slate-200">
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {item.name} {item.value} {item.statedUnit}
              </span>{" "}
              — the stated range {prettyRange(item.statedRange)} matches{" "}
              <span className="font-medium">{item.correctedUnit}</span>, not{" "}
              <span className="font-medium">{item.statedUnit}</span>. Correct
              the unit to {item.correctedUnit}?
            </div>
            <div
              className="mt-1 text-xs text-slate-500 dark:text-slate-400"
              data-testid="unit-mislabel-beforeafter"
            >
              <span className="line-through">
                {item.value} {item.statedUnit}
              </span>{" "}
              → {item.value} {item.correctedUnit}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="unit-mislabel-apply"
                onClick={() => void onApply(item)}
                className="btn btn-sm"
              >
                <IconWand className="h-4 w-4" stroke={1.75} />
                Correct to {item.correctedUnit}
              </button>
              <button
                type="button"
                data-testid="unit-mislabel-dismiss"
                onClick={() => void onDismiss(item)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-ink-750"
              >
                <IconEyeOff className="h-4 w-4" stroke={1.75} />
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
