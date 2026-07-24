"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listSharedSupplyOptions,
  createPoolAction,
  linkItemAction,
  unlinkItemAction,
} from "@/app/(app)/supplies/actions";

// The "Shared supply" control (#1374), rendered inside the refill block of BOTH intake
// forms (the one shared RefillTracking component, so supplements and medications get it
// together — the #746 split is per-surface, a bottle has no kind).
//
// It is deliberately its OWN submit rather than a field of the item form: linking is a
// one-way migration of the item's count INTO the pool, and folding that into the item
// save would put it behind the same #467 compare-and-set the private counter uses, where
// "the user didn't touch the quantity field" and "the quantity moved to a pool" mean
// opposite things. Separate actions keep each write's intent unambiguous — and let an
// EXISTING item be shared without re-saving the whole medication.
//
// A brand-new (unsaved) item has no id to link, so the control explains that sharing
// becomes available once the item is saved.
export default function SharedSupplyPicker({
  itemId,
  itemName,
  supplyId,
  supplyName,
}: {
  itemId?: number;
  itemName: string;
  supplyId: number | null;
  supplyName: string | null;
}) {
  const [options, setOptions] = useState<
    { id: number; name: string; strength: string | null }[]
  >([]);
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<string>(
    supplyId != null ? String(supplyId) : ""
  );
  const [newName, setNewName] = useState(itemName);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!itemId || loaded) return;
    let live = true;
    void listSharedSupplyOptions().then((opts) => {
      if (!live) return;
      setOptions(opts);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [itemId, loaded]);

  if (!itemId) {
    return (
      <div
        data-testid="shared-supply-picker"
        className="sm:col-span-2 mt-3 text-xs text-slate-500 dark:text-slate-400"
      >
        Save this item first to share its bottle with another household member.
      </div>
    );
  }

  const apply = (): void => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("item_id", String(itemId));
      let res;
      if (choice === "") {
        res = await unlinkItemAction(fd);
      } else if (choice === "__new__") {
        fd.set("name", newName.trim() || itemName);
        res = await createPoolAction(fd);
      } else {
        fd.set("supply_id", choice);
        res = await linkItemAction(fd);
      }
      if (!res.ok) setError(res.error ?? "Couldn't update the shared supply.");
    });
  };

  return (
    <div
      data-testid="shared-supply-picker"
      className="sm:col-span-2 mt-4 border-t border-black/5 pt-4 dark:border-white/5"
    >
      <label
        className="label"
        htmlFor={`shared-supply-${itemId}`}
        data-testid="shared-supply-label"
      >
        Shared supply
      </label>
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
        {supplyName
          ? `This item draws from the shared bottle “${supplyName}”. Everyone linked to it decrements one count.`
          : "Link this item to a bottle the household shares, so every taker's doses decrement one count."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`shared-supply-${itemId}`}
          className="input max-w-xs"
          value={choice}
          disabled={pending}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Not shared</option>
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {o.name}
              {o.strength ? ` (${o.strength})` : ""}
            </option>
          ))}
          <option value="__new__">Create a new shared bottle…</option>
        </select>
        {choice === "__new__" && (
          <input
            className="input max-w-xs"
            aria-label="New shared bottle name"
            data-testid="shared-supply-new-name"
            value={newName}
            disabled={pending}
            onChange={(e) => setNewName(e.target.value)}
          />
        )}
        <button
          type="button"
          className="btn-secondary"
          data-testid="shared-supply-apply"
          disabled={pending}
          onClick={apply}
        >
          {pending ? "Saving…" : "Apply"}
        </button>
      </div>
      {choice === "__new__" && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          The count currently on this item moves into the new shared bottle —
          one way, once.
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}
    </div>
  );
}
