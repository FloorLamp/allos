// The product-fact exchange between a shared bottle and an intake item (#1705).
//
// THE SPLIT (owner-decided, #1705). A shared bottle owns WHAT THE PRODUCT IS; the item
// owns HOW THIS PERSON USES IT:
//
//   pool (authoritative)          item (never overridden)
//   ─────────────────────────     ──────────────────────────────────────────
//   name / strength / form        this person's dose amount and schedule
//   the on-hand count             obligation, situation gating, notes
//   the low-supply threshold      the item's own display name
//
// AUTHORITY BY DERIVATION, NOT BY COPYING. `intake_items` carries NO `strength` and no
// `form` column — a pooled item therefore has no duplicate of the bottle's product facts
// that could drift, and editing the bottle changes every member's display with no write
// to anyone's row. The same posture the on-hand count already takes.
//
// WHERE "STRENGTH" LIVES ON AN ITEM. Dose strength (mg/IU) reuses the existing dose
// `amount` (lib/types/intake.ts) — that is the field a user actually types "5000 IU"
// into. So the ITEM side of this exchange is its first active dose amount, and nothing
// here ever writes an amount back onto an item behind the user's back: the seeds below
// are FORM PREFILLS, editable before save.
//
// Pure: no db, no auth, no React. One computation for both directions, so the pool
// created from an item and the item created from a pool can never disagree.

import type { IntakeItemKind } from "./types/intake";

// A bottle's product identity, as `shared_supplies` stores it.
export interface PoolProductFacts {
  name: string;
  strength: string | null;
  form: string | null;
}

// One offerable bottle: its product identity plus the id an item links by. The shape the
// item form's picker renders and the item's create action validates. Declared here rather
// than beside the Server Actions because a `"use server"` module may only export async
// functions.
export interface SupplyOption extends PoolProductFacts {
  id: number;
}

// An item's product identity, as `intake_items` (+ its active doses) stores it.
export interface ItemProductFacts {
  name: string;
  // Active (non-retired) dose amounts in display order. The FIRST non-empty one is
  // what a user typed as the strength.
  doseAmounts: readonly string[];
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

// The item's strength as typed: its first non-empty active dose amount.
export function itemStrength(item: ItemProductFacts): string | null {
  for (const amount of item.doseAmounts) {
    const value = clean(amount);
    if (value) return value;
  }
  return null;
}

// DIRECTION 1 — creating a bottle FROM an item. Seeds the pool's product identity from
// what the user already entered, so the bottle is recognisably the same substance as the
// item drawing on it instead of a retyped near-miss. `form` has no item-side source (no
// such column), so it is left for the user; the count seeding stays where it is (the
// action's one-way migration of the item's on-hand INTO the pool).
export function poolSeedFromItem(item: ItemProductFacts): {
  name: string;
  strength: string | null;
} {
  return { name: item.name.trim(), strength: itemStrength(item) };
}

// DIRECTION 2 — creating an item FROM a bottle. Prefills the item form's product fields;
// the amount seed is the bottle's strength, which the user may edit before saving
// because the DOSE is theirs, not the bottle's.
export function itemSeedFromPool(pool: PoolProductFacts): {
  name: string;
  amount: string;
} {
  return { name: pool.name.trim(), amount: clean(pool.strength) ?? "" };
}

// Prefill without clobbering. A field is seeded when it is empty, or when it still holds
// the value the PREVIOUS pick put there (so switching bottles corrects the prefill) —
// never when the user has typed something of their own.
export function applyProductSeed(
  current: string,
  previousSeed: string | null,
  next: string
): string {
  if (current.trim() === "") return next;
  if (previousSeed != null && current === previousSeed) return next;
  return current;
}

// A bottle's product identity as ONE label — "5000 IU · capsule". Shared by the picker's
// option text, the shared-bottle chip's tooltip and the cabinet card, so a bottle reads
// the same everywhere. Null when the bottle carries neither fact.
export function productLabel(pool: {
  strength: string | null;
  form: string | null;
}): string | null {
  const parts = [clean(pool.strength), clean(pool.form)].filter(
    (p): p is string => p != null
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

// The bottle as one selectable line — "Vitamin D3 (5000 IU · capsule)".
export function bottleLabel(pool: PoolProductFacts): string {
  const detail = productLabel(pool);
  return detail ? `${pool.name} (${detail})` : pool.name;
}

// Which surface an item created FROM a bottle belongs on. A bottle has no kind of its
// own (#1374), so the destination is read off its membership: a household bottle holding
// a MEDICATION is a medication for the next person too (the safety-leaning direction —
// the medication surface carries the prescribing, interaction and course machinery).
// A bottle nobody links yet defaults to the supplement surface.
export function poolSurfaceKind(
  members: readonly { kind: IntakeItemKind }[]
): IntakeItemKind {
  return members.some((m) => m.kind === "medication")
    ? "medication"
    : "supplement";
}
