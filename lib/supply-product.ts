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
  // The bottle's own count, so the intake form's combobox can offer it as what it is —
  // "shared bottle · 143 left" — rather than as a bare name indistinguishable from a
  // vocabulary entry (#3216 decision 3).
  onHand?: number | null;
  // The kind of the items ALREADY drawing from this bottle, when there are any. A
  // bottle has no kind of its own (#1374); this is a sibling's, lent to the item
  // form's kind derivation and to nothing else. Null (or absent) for a bottle nobody
  // links yet, which is exactly the case that falls back to asking.
  siblingKind?: IntakeItemKind | null;
}

// The bottle's row in the intake form's name combobox: what it is, and how much is in
// it. The suffix is what tells a picker that this row is a BOTTLE and not a catalog
// entry, so it is also what identifies the row on the way back.
export const BOTTLE_OPTION_SUFFIX = " — shared bottle";

export function bottleOptionLabel(option: SupplyOption): string {
  const left =
    option.onHand != null && option.onHand >= 0
      ? ` · ${option.onHand} left`
      : "";
  return `${bottleLabel(option)}${BOTTLE_OPTION_SUFFIX}${left}`;
}

// The bottle a combobox row came from, or null when the row was a vocabulary entry.
export function bottleForOptionLabel(
  options: readonly SupplyOption[],
  label: string
): SupplyOption | null {
  return options.find((o) => bottleOptionLabel(o) === label) ?? null;
}

// The kind a bottle LENDS, from the items already drawing on it. Null when nothing
// links it yet — a bottle is not evidence about a substance, only its members are.
export function bottleSiblingKind(
  members: readonly { kind: IntakeItemKind }[]
): IntakeItemKind | null {
  return members.length === 0 ? null : poolSurfaceKind(members);
}

// Which bottles a KIND-LOCKED door may offer (#3270).
//
// A locked door does not ask and cannot be corrected — lib/intake-kind.ts puts
// `locked` first with `correctable: false` — so a bottle it offers is a bottle whose
// pick WRITES the door's kind, silently. Offering the household's ibuprofen in the Add
// supplement door therefore does not file a medication under a warning; it files a
// SUPPLEMENT named Ibuprofen. `kind` picks the dose vocabulary and the suggestion lists
// (#846) and is what the interaction and PRN-ceiling paths read, so that row is wrong in
// every one of those places with nothing on screen to say so.
//
// THE NO-SIBLING CASE, decided here (#3270). A bottle nobody links yet is OFFERED in
// every door. A bottle has no kind of its own (#1374) and borrows one from a linked
// sibling (#3216 decision 3), so with no sibling there is nothing being contradicted:
// the door's kind is the only reading available and it is an honest one — it says what
// the person just chose. Withholding it instead would make the shared-bottle front door
// (#1705) omit household bottles for a reason invisible on the screen, which is the
// worse failure of the two precisely because nothing on the surface can explain it.
// This also keeps the browse list in step with the cabinet's own deep link, which sends
// an unlinked bottle to a door (poolSurfaceKind defaults to supplement) that would
// otherwise be the only place it could be reached from.
//
// Not poolSurfaceKind's question. That one must NAME a kind because it picks a
// destination for an item created from a bottle; here the door has already named it,
// and the only question left is whether the bottle contradicts it.
export function bottleFitsKindDoor(
  bottle: Pick<SupplyOption, "siblingKind">,
  lockedKind: IntakeItemKind | null
): boolean {
  if (lockedKind == null) return true;
  const sibling = bottle.siblingKind ?? null;
  return sibling == null || sibling === lockedKind;
}

// The same rule over a list — what a door actually offers. Named once so the door's
// OFFER set and the set it RESOLVES a pick against cannot drift apart: a row nobody
// was shown must not become linkable by typing its label.
export function bottlesForKindDoor<T extends Pick<SupplyOption, "siblingKind">>(
  bottles: readonly T[],
  lockedKind: IntakeItemKind | null
): T[] {
  return bottles.filter((b) => bottleFitsKindDoor(b, lockedKind));
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
