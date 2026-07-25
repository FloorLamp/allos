"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import NotesText from "@/components/NotesText";
import { updatePoolAction, deletePoolAction } from "./actions";

export interface SharedSupplyCardData {
  id: number;
  name: string;
  strength: string | null;
  form: string | null;
  notes: string | null;
  quantityOnHand: number | null;
  lowSupplyDays: number | null;
  thresholdDays: number;
  daysLeft: number | null;
  low: boolean;
  orphaned: boolean;
  memberCount: number;
  // Linked members the VIEWER may not see by name (#1374 cross-grant visibility): the
  // count is shown, the names are not.
  hiddenMemberCount: number;
  members: { itemId: number; label: string; canWrite: boolean }[];
  canWrite: boolean;
}

// One shared bottle in the cabinet. The edit form is an EXPLICIT submit (the #794 rule:
// only Settings autosaves), and it round-trips the quantity it LOADED with so the pool's
// #467 compare-and-set can keep a linked member's concurrent dose decrement instead of
// clobbering it.
export default function SharedSupplyCard({
  pool,
}: {
  pool: SharedSupplyCardData;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (formData: FormData): void => {
    setError(null);
    start(async () => {
      const res = await updatePoolAction(formData);
      if (!res.ok) setError(res.error ?? "Couldn't save.");
      else {
        setOpen(false);
        router.refresh();
      }
    });
  };

  const remove = (): void => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("id", String(pool.id));
      const res = await deletePoolAction(fd);
      if (!res.ok) setError(res.error ?? "Couldn't delete.");
      else {
        setConfirming(false);
        router.refresh();
      }
    });
  };

  const daysText =
    pool.daysLeft == null
      ? "No estimate yet"
      : pool.daysLeft <= 0
        ? "Out of supply"
        : `≈${pool.daysLeft} day${pool.daysLeft === 1 ? "" : "s"} left${
            pool.memberCount > 1 ? " across everyone" : ""
          }`;

  return (
    <div className="card" data-testid="shared-supply-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-base font-semibold text-slate-800 dark:text-slate-100"
            data-testid="shared-supply-name"
          >
            {pool.name}
            {pool.strength ? (
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {pool.strength}
                {pool.form ? ` · ${pool.form}` : ""}
              </span>
            ) : pool.form ? (
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {pool.form}
              </span>
            ) : null}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            <span data-testid="shared-supply-days">{daysText}</span>
            {pool.quantityOnHand != null && (
              <>
                {" · "}
                <span data-testid="shared-supply-quantity">
                  {pool.quantityOnHand} on hand
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pool.low && (
            <span
              className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              data-testid="shared-supply-low"
            >
              Low
            </span>
          )}
          {pool.orphaned && (
            <span
              className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
              data-testid="shared-supply-orphaned"
            >
              No longer linked
            </span>
          )}
          {pool.canWrite && (
            <button
              type="button"
              className="btn-secondary"
              data-testid="shared-supply-edit"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Cancel" : "Edit"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        {pool.members.length > 0 ? (
          <ul data-testid="shared-supply-members" className="space-y-1">
            {pool.members.map((m) => (
              <li key={m.itemId}>{m.label}</li>
            ))}
          </ul>
        ) : (
          <p data-testid="shared-supply-no-members">
            Nothing links to this bottle any more. Its count is kept until you
            delete it — nothing is removed on your behalf.
          </p>
        )}
        {pool.hiddenMemberCount > 0 && (
          <p
            className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            data-testid="shared-supply-hidden-members"
          >
            +{pool.hiddenMemberCount} other household member
            {pool.hiddenMemberCount === 1 ? "" : "s"} you don’t have access to
          </p>
        )}
      </div>

      {pool.notes && (
        <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          <NotesText notes={pool.notes} />
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {open && (
        <form action={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="id" value={pool.id} />
          {/* The value this form LOADED with, so the action can compare-and-set the
              concurrently-decremented pool counter instead of clobbering it (#467). */}
          <input
            type="hidden"
            name="quantity_on_hand_loaded"
            value={pool.quantityOnHand ?? ""}
          />
          <div>
            <label className="label" htmlFor={`pool-name-${pool.id}`}>
              Name
            </label>
            <input
              id={`pool-name-${pool.id}`}
              name="name"
              className="input"
              defaultValue={pool.name}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor={`pool-strength-${pool.id}`}>
              Strength
            </label>
            <input
              id={`pool-strength-${pool.id}`}
              name="strength"
              className="input"
              defaultValue={pool.strength ?? ""}
              placeholder="e.g. 200 mg"
            />
          </div>
          <div>
            <label className="label" htmlFor={`pool-form-${pool.id}`}>
              Form
            </label>
            <input
              id={`pool-form-${pool.id}`}
              name="form"
              className="input"
              defaultValue={pool.form ?? ""}
              placeholder="e.g. tablet"
            />
          </div>
          <div>
            <label className="label" htmlFor={`pool-qty-${pool.id}`}>
              Quantity on hand
            </label>
            <input
              id={`pool-qty-${pool.id}`}
              name="quantity_on_hand"
              type="number"
              min={0}
              step="any"
              className="input"
              data-testid="shared-supply-qty-input"
              defaultValue={pool.quantityOnHand ?? ""}
            />
          </div>
          <div>
            <label className="label" htmlFor={`pool-threshold-${pool.id}`}>
              Refill when days left drops to
            </label>
            <input
              id={`pool-threshold-${pool.id}`}
              name="low_supply_days"
              type="number"
              min={1}
              step={1}
              className="input"
              defaultValue={pool.lowSupplyDays ?? ""}
              placeholder={String(pool.thresholdDays)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor={`pool-notes-${pool.id}`}>
              Notes
            </label>
            <textarea
              id={`pool-notes-${pool.id}`}
              name="notes"
              className="input"
              rows={2}
              defaultValue={pool.notes ?? ""}
            />
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="btn-primary"
              data-testid="shared-supply-save"
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            {confirming ? (
              <>
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  Delete this bottle?{" "}
                  {pool.memberCount > 1
                    ? `Its ${pool.memberCount} linked items go back to untracked supply${
                        pool.quantityOnHand != null
                          ? ` — ${pool.quantityOnHand} on hand is not copied to any of them`
                          : ""
                      }.`
                    : pool.memberCount === 1
                      ? "Its one linked item takes the remaining count back."
                      : "Nothing links to it."}
                </span>
                <button
                  type="button"
                  className="btn-danger"
                  data-testid="shared-supply-delete-confirm"
                  disabled={pending}
                  onClick={remove}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-secondary"
                data-testid="shared-supply-delete"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Delete bottle
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
