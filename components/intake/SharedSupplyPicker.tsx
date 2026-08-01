"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  listSharedSupplyOptions,
  createPoolAction,
  linkItemAction,
  unlinkItemAction,
} from "@/app/(app)/supplies/actions";
import { SUPPLIES_HREF } from "@/lib/hrefs";
import { bottleLabel, type SupplyOption } from "@/lib/supply-product";

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
// A brand-new (unsaved) item has no id to LINK — but since #1705 it has the other
// direction: choosing a bottle here seeds the item form's product fields and rides along
// as `supply_id` on the item's own save, so the household flow ("there's a shared bottle
// of D3 5000 IU; add it for my daughter") is one step. That branch posts a field instead
// of calling an action, which is why it needs no Apply button of its own.
export default function SharedSupplyPicker({
  itemId,
  itemName,
  supplyId,
  supplyName,
  initialSupply = null,
  onPickSupply,
}: {
  itemId?: number;
  itemName: string;
  supplyId: number | null;
  supplyName: string | null;
  // CREATE mode only (#1705): the bottle this form was opened from, e.g. the cabinet's
  // "Add for another person". Preselected and pre-seeded.
  initialSupply?: SupplyOption | null;
  // CREATE mode only: hands the chosen bottle to the item form so it can prefill the
  // product fields it owns the inputs for.
  onPickSupply?: (supply: SupplyOption | null) => void;
}) {
  const [options, setOptions] = useState<SupplyOption[]>(
    initialSupply ? [initialSupply] : []
  );
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<string>(
    supplyId != null
      ? String(supplyId)
      : initialSupply
        ? String(initialSupply.id)
        : ""
  );
  const [savedChoice, setSavedChoice] = useState<string>(
    supplyId != null ? String(supplyId) : ""
  );
  const [activeSupplyName, setActiveSupplyName] = useState(supplyName);
  const [newName, setNewName] = useState(itemName);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const nextChoice = supplyId != null ? String(supplyId) : "";
    setChoice(nextChoice);
    setSavedChoice(nextChoice);
    setActiveSupplyName(supplyName);
  }, [supplyId, supplyName]);

  useEffect(() => {
    if (loaded) return;
    let live = true;
    void listSharedSupplyOptions().then((opts) => {
      if (!live) return;
      setOptions(opts);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [loaded]);

  // CREATE mode (#1705). No item exists yet, so there is nothing to link and no action to
  // call: the chosen bottle rides on the item form's OWN submit as `supply_id`, and the
  // pick is handed up so the form can seed the product fields from it.
  if (!itemId) {
    const picked = options.find((o) => String(o.id) === choice) ?? null;
    return (
      <div
        data-testid="shared-supply-picker"
        className="sm:col-span-2 mt-4 border-t border-black/5 pt-4 dark:border-white/5"
      >
        <label className="label" htmlFor="shared-supply-new-item">
          Shared supply
        </label>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Draw this item from a bottle the household already shares — the bottle
          keeps the count for everyone linked to it.
        </p>
        <input type="hidden" name="supply_id" value={choice} />
        <select
          id="shared-supply-new-item"
          className="input max-w-xs"
          data-testid="shared-supply-new-item-select"
          value={choice}
          onChange={(e) => {
            const next = e.target.value;
            setChoice(next);
            onPickSupply?.(options.find((o) => String(o.id) === next) ?? null);
          }}
        >
          <option value="">Not shared</option>
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {bottleLabel(o)}
            </option>
          ))}
        </select>
        {picked && (
          <p
            className="mt-2 text-xs text-slate-500 dark:text-slate-400"
            data-testid="shared-supply-new-item-note"
          >
            This item will draw from “{bottleLabel(picked)}”. Its dose and
            schedule stay yours; the bottle keeps the count.
          </p>
        )}
      </div>
    );
  }

  const apply = (): void => {
    setError(null);
    setSuccess(null);
    start(async () => {
      try {
        const appliedChoice = choice;
        const fd = new FormData();
        fd.set("item_id", String(itemId));
        let res;
        if (appliedChoice === "") {
          res = await unlinkItemAction(fd);
        } else if (appliedChoice === "__new__") {
          fd.set("name", newName.trim() || itemName);
          res = await createPoolAction(fd);
        } else {
          fd.set("supply_id", appliedChoice);
          res = await linkItemAction(fd);
        }
        if (!res.ok) {
          setError(res.error ?? "Couldn't update the shared supply.");
          return;
        }

        const supply = res.supply;
        if (supply) {
          const nextChoice = String(supply.id);
          setOptions((current) =>
            [
              ...current.filter((option) => option.id !== supply.id),
              supply,
            ].sort((a, b) => a.name.localeCompare(b.name))
          );
          setChoice(nextChoice);
          setSavedChoice(nextChoice);
          setActiveSupplyName(supply.name);
          setSuccess(
            appliedChoice === "__new__"
              ? `Created and linked “${supply.name}”.`
              : `Linked to “${supply.name}”.`
          );
        } else {
          setChoice("");
          setSavedChoice("");
          setActiveSupplyName(null);
          setSuccess("Shared supply removed.");
        }
      } catch {
        setError("Couldn't update the shared supply.");
      }
    });
  };
  const changed = choice === "__new__" || choice !== savedChoice;

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
        {activeSupplyName
          ? `This item draws from the shared bottle “${activeSupplyName}”. Everyone linked to it decrements one count.`
          : "Link this item to a bottle the household shares, so every taker's doses decrement one count."}
      </p>
      {/* The natural "see all bottles" exit (#1522). Only once a pool is actually
        linked: with nothing shared there is no cabinet to walk out to, and the select
        below is the way IN. The cabinet has no nav row — this is one of its doors. */}
      {activeSupplyName && (
        <p className="mb-2 text-xs">
          <Link
            href={SUPPLIES_HREF}
            data-testid="shared-supply-cabinet-link"
            className="font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            See all shared bottles →
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`shared-supply-${itemId}`}
          className="input max-w-xs"
          value={choice}
          disabled={pending}
          onChange={(e) => {
            setChoice(e.target.value);
            setError(null);
            setSuccess(null);
          }}
        >
          <option value="">Not shared</option>
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {bottleLabel(o)}
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
            onChange={(e) => {
              setNewName(e.target.value);
              setError(null);
              setSuccess(null);
            }}
          />
        )}
        <button
          type="button"
          className="btn btn-sm"
          data-testid="shared-supply-apply"
          disabled={pending || !changed}
          aria-busy={pending}
          onClick={apply}
        >
          {pending ? "Saving…" : "Apply"}
        </button>
      </div>
      {choice === "__new__" && (
        <p
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
          data-testid="shared-supply-new-hint"
        >
          The new bottle inherits this item’s name and strength, and the count
          currently on the item moves into it — one way, once.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 text-xs text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}
      {success && (
        <p
          role="status"
          data-testid="shared-supply-success"
          className="mt-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          {success}
        </p>
      )}
    </div>
  );
}
