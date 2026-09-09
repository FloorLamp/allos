"use client";

import { useState, useTransition } from "react";
import NotesText from "@/components/NotesText";
import ProfileSwitcherChip from "@/components/ProfileSwitcherChip";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import type { AppRoute } from "@/lib/hrefs";
import { productLabel } from "@/lib/supply-product";
import type { AvatarProfile } from "@/components/Avatar";
import { updatePoolAction, deletePoolAction, alsoForAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import Link from "next/link";

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
  members: {
    itemId: number;
    label: string;
    canWrite: boolean;
    href: AppRoute;
    profile: AvatarProfile;
    acting: boolean;
  }[];
  // "Also for" (#5230). `sources` are the members whose plan may be copied — the ones
  // this viewer can actually SEE, because a plan behind a grant is not a plan they may
  // copy. `offers` are the people the copy is offered FOR, derived per person from
  // access, membership, allergy, life stage and whether a dose is derivable at all.
  // Each offer carries the BASIS it was derived from, per source: the tap posts it back
  // and the write refuses a stale one rather than copying a different member's plan.
  alsoFor: {
    sources: {
      itemId: number;
      profileId: number;
      personName: string;
      scheduleLabel: string;
    }[];
    offers: {
      profileId: number;
      name: string;
      basisBySource: Record<number, string>;
    }[];
  };
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
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  // The source is a choice about THIS displayed offer, not a saved household default.
  // One readable member IS the choice and is named above; several start empty.
  const alsoForSources = pool.alsoFor.sources;
  const [sourceItemId, setSourceItemId] = useState(
    alsoForSources.length === 1 ? String(alsoForSources[0].itemId) : ""
  );
  const [receipt, setReceipt] = useState<{
    text: string;
    href: AppRoute;
  } | null>(null);
  const source =
    alsoForSources.find((s) => String(s.itemId) === sourceItemId) ?? null;
  // PAST A CHIP COUNT THE CARD FALLS BACK TO A SELECT, with the same verb (#5230
  // shape item 1). A household card carries a handful of chips in one wrapping row;
  // an ADMIN reaches every profile in the instance, and a card cannot render a
  // hundred of them. Four is the layout number, not a rule about people.
  const manyOffers = pool.alsoFor.offers.length > 4;
  // The card RE-RENDERS after the tap (the action revalidates /supplies), so the person
  // just added is a member now and their offer is gone. The receipt must outlive that —
  // it is what says the tap worked and where the new row is — so the block stays while
  // a receipt is standing, with the controls hidden once there is nobody left to offer.
  const offersOpen = pool.alsoFor.offers.length > 0;
  const [offerProfileId, setOfferProfileId] = useState("");
  const offer =
    pool.alsoFor.offers.find((o) => String(o.profileId) === offerProfileId) ??
    null;

  const alsoFor = (offer: {
    profileId: number;
    basisBySource: Record<number, string>;
  }): void => {
    if (!source) return;
    setError(null);
    setReceipt(null);
    start(async () => {
      const fd = new FormData();
      fd.set("supply_id", String(pool.id));
      fd.set("source_item_id", String(source.itemId));
      fd.set("source_profile_id", String(source.profileId));
      fd.set("profile_id", String(offer.profileId));
      fd.set("basis", offer.basisBySource[source.itemId] ?? "");
      const res = await alsoForAction(fd);
      if (!res.ok || !res.receipt || !res.href) {
        setError(res.error ?? "Couldn’t add it.");
        return;
      }
      setReceipt({ text: res.receipt, href: res.href });
    });
  };

  const submit = (formData: FormData): void => {
    setError(null);
    start(async () => {
      const res = await updatePoolAction(formData);
      if (!res.ok) setError(res.error ?? "Couldn't save.");
      else {
        setOpen(false);
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
      }
    });
  };

  // The bottle's product identity as ONE label — the same computation the picker's
  // options and the linked items' chips read (#1705), so a bottle reads the same
  // everywhere it appears.
  const product = productLabel(pool);
  const daysText =
    pool.daysLeft == null
      ? "No estimate yet"
      : pool.daysLeft <= 0
        ? "Out of supply"
        : `≈${pool.daysLeft} day${pool.daysLeft === 1 ? "" : "s"} left${
            pool.memberCount > 1 ? " across everyone" : ""
          }`;
  const deleteConsequence =
    pool.memberCount > 1
      ? `Its ${pool.memberCount} linked items will go back to untracked supply${
          pool.quantityOnHand != null
            ? `; ${pool.quantityOnHand} on hand will not be copied to any of them`
            : ""
        }.`
      : pool.memberCount === 1
        ? "Its one linked item will take the remaining count back."
        : "Nothing is linked to it.";

  return (
    <div
      id={`supply-${pool.id}`}
      className="card"
      data-testid="shared-supply-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-base font-semibold text-slate-800 dark:text-slate-100"
            data-testid="shared-supply-name"
          >
            {pool.name}
            {product && (
              <span
                className="ml-2 font-normal text-slate-500 dark:text-slate-400"
                data-testid="shared-supply-product"
              >
                {product}
              </span>
            )}
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
            <OverflowMenu
              kind="Bottle"
              itemName={pool.name}
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    data-testid="shared-supply-edit"
                    disabled={pending}
                    onClick={() => {
                      setOpen(true);
                      close();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM_DANGER}
                    data-testid="shared-supply-delete"
                    disabled={pending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete bottle",
                        message: (
                          <>
                            Delete “{pool.name}”? {deleteConsequence}
                          </>
                        ),
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      close();
                      remove();
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </OverflowMenu>
          )}
        </div>
      </div>

      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
        {pool.members.length > 0 ? (
          <ul data-testid="shared-supply-members" className="space-y-1">
            {pool.members.map((m) => (
              <li key={m.itemId}>
                <ProfileSwitcherChip
                  profile={m.profile}
                  acting={m.acting}
                  destination={m.href}
                  label={m.label}
                  testId="shared-supply-member-link"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="shared-supply-no-members">
            Nothing links to this bottle any more. Its count is kept until you
            delete it — nothing is removed on your behalf.
          </p>
        )}
        {/* The bottle → item direction (#5230). A shared bottle is one PRODUCT, so
            adding it for someone else is a ROW COPY, not a form: one tap copies the
            named member's obligation and schedule and derives that person's own dose.
            The caller never becomes anyone else — their active profile is untouched.

            THE SOURCE IS ALWAYS NAMED (owner ruling, 2026-09-09). Members can keep
            different schedules on one bottle, so the offer states whose plan it will
            copy. With one readable member that is a sentence; with several it is a
            selector with NOTHING preselected, and the actions stay disabled until the
            person picks — even when the schedules read the same, because the copy still
            takes one specific member's plan. Never the first SQL row, never the acting
            profile. */}
        {alsoForSources.length > 0 &&
          (pool.alsoFor.offers.length > 0 || receipt) && (
            <div className="mt-3" data-testid="shared-supply-also-for">
              {offersOpen &&
                (alsoForSources.length === 1 ? (
                  <p
                    className="text-sm text-slate-600 dark:text-slate-300"
                    data-testid="shared-supply-also-for-source"
                  >
                    Copying {alsoForSources[0].personName}’s schedule ·{" "}
                    {alsoForSources[0].scheduleLabel}
                  </p>
                ) : (
                  <div>
                    <label
                      className="label"
                      htmlFor={`pool-also-for-${pool.id}`}
                    >
                      Copy schedule from
                    </label>
                  </div>
                ))}
              {/* ONE CONTROL HEIGHT IN THIS ROW (#3481): the select is the `.input`
                family at the `.btn` desktop height, and both families share the phone
                tap floor (#3708/#3514). Guarded by e2e/shared-supply-pool.spec.ts. */}
              {offersOpen && (
                <div
                  className="mt-1 flex flex-wrap items-end gap-2"
                  data-testid="shared-supply-also-for-row"
                >
                  {alsoForSources.length > 1 && (
                    <select
                      id={`pool-also-for-${pool.id}`}
                      className="input h-9 max-w-xs"
                      data-testid="shared-supply-also-for-select"
                      value={sourceItemId}
                      onChange={(e) => {
                        setSourceItemId(e.target.value);
                        setReceipt(null);
                      }}
                    >
                      <option value="">Choose a person</option>
                      {alsoForSources.map((s) => (
                        <option key={s.itemId} value={s.itemId}>
                          {s.personName} · {s.scheduleLabel}
                        </option>
                      ))}
                    </select>
                  )}
                  {manyOffers ? (
                    <>
                      <select
                        aria-label="Also for"
                        className="input h-9 max-w-xs"
                        data-testid="shared-supply-also-for-person"
                        value={offerProfileId}
                        onChange={(e) => {
                          setOfferProfileId(e.target.value);
                          setReceipt(null);
                        }}
                      >
                        <option value="">Choose a person</option>
                        {pool.alsoFor.offers.map((o) => (
                          <option key={o.profileId} value={o.profileId}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn"
                        data-testid="shared-supply-also-for-chip"
                        disabled={pending || source == null || offer == null}
                        onClick={() => offer && alsoFor(offer)}
                      >
                        Also for
                      </button>
                    </>
                  ) : (
                    pool.alsoFor.offers.map((o) => (
                      <button
                        key={o.profileId}
                        type="button"
                        className="btn"
                        data-testid="shared-supply-also-for-chip"
                        disabled={pending || source == null}
                        onClick={() => alsoFor(o)}
                      >
                        {o.name} · Also for
                      </button>
                    ))
                  )}
                </div>
              )}
              {receipt && (
                <p
                  className="mt-2 text-sm text-slate-600 dark:text-slate-300"
                  data-testid="shared-supply-also-for-receipt"
                >
                  {receipt.text}{" "}
                  <Link className="link" href={receipt.href}>
                    Open their row
                  </Link>
                </p>
              )}
            </div>
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
            <SubmitButton
              variant="primary"
              data-testid="shared-supply-save"
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </SubmitButton>
            <button
              type="button"
              className="btn-ghost"
              disabled={pending}
              onClick={() => {
                setError(null);
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
