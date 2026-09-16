// WHAT A LOW-SUPPLY CUE CAN MOUNT THE SHARED REFILL ACTION ON (#5121 §9, #5907).
//
// A pure projection over one profile's already-read intake items, producing one target
// per low-supply cue KEY. The keys are minted by the same two minters the cues
// themselves carry — `refillSignalKey` for a private supply (`refillItems`) and
// `poolRefillSignalKey` for a shared bottle (`poolRefillItems`, in ./intake-safety) —
// so a cue and its control are joined on the identity the producer stamped rather than
// by parsing one back out of a string.
//
// PURE, AND PARAMETERISED ON THE LIST rather than on a profile id: the caller hands in
// the snapshot-cached `getIntakeItems` result it already took, so asking for the
// targets costs no read of its own, and every claim below is checkable against
// `poolRefillItems` without a page or a request.

import { poolRefillSignalKey, refillSignalKey } from "@/lib/refill-nudge";
import type { IntakeItem } from "@/lib/types";

// One cue's refill target. `supplyId` is the bottle when the cue is a pooled one and
// null for a private supply; `lastFillSize` is the remembered fill, whose ABSENCE is
// what makes the tap ask for a size instead of writing one.
export interface RefillCueTarget {
  itemId: number;
  supplyId: number | null;
  lastFillSize: number | null;
}

// The targets for every cue key this profile's items can raise, private and pooled.
export function refillCueTargets(
  items: readonly IntakeItem[]
): Map<string, RefillCueTarget> {
  const refillTargets = new Map<string, RefillCueTarget>();
  for (const item of items) {
    // A MEMBER OF A POOL GETS NO PRIVATE KEY. Its `refill:<id>` entry carried the
    // member's `supply_id`, so mounting it would have written to the BOTTLE under a
    // key that names one person's item; it was unreachable only because linking nulls
    // `quantity_on_hand` and `refillItems` requires one — a convention six write cores
    // keep and no CHECK constraint enforces. Not writing it makes a caller structurally
    // incapable of mounting a pool-writing refill anywhere but on the pooled key.
    if (item.supply_id == null) {
      refillTargets.set(refillSignalKey(item.id), {
        itemId: item.id,
        supplyId: null,
        lastFillSize: item.last_fill_size,
      });
      continue;
    }
    // A POOLED BOTTLE IS KEYED ON THE POOL, never on a member (#1374), and its cue
    // names ONE subject. `poolRefillItems` picks this profile's lowest-id member to
    // carry it, so the same pick is made here — the row and its control then act on
    // the same item, and a second member of the same bottle can never mint a rival
    // control for it.
    const poolKey = poolRefillSignalKey(item.supply_id);
    const seated = refillTargets.get(poolKey);
    if (seated == null || item.id < seated.itemId)
      refillTargets.set(poolKey, {
        itemId: item.id,
        supplyId: item.supply_id,
        // NO MEMBER'S REMEMBERED FILL REACHES A POOLED TARGET HERE. Carrying it is a
        // POSITION — this profile's lowest id, picked to aim an href — and a position's
        // fill size is not the bottle's. No predicate over the member rescues it: one
        // the pool rates at nothing (paused, situationally held, never dosed) is one
        // case, and a member refilled at 30 while it was still PRIVATE and only then
        // linked is another, because `linkItemToPool` drops the private count and keeps
        // `last_fill_size` — a number that was never a fill of this jar, on a fully
        // active sole member. So the input is removed rather than filtered.
        //
        // THE CONSEQUENCE, PLAINLY: the pooled target is null on EVERY render, not only
        // the first, so a pooled cue built from this map asks for a size on EVERY tap.
        // That is the reviewed design — the household's count moves only by a number
        // someone typed for THIS bottle — and not a first-use path that later remembers.
        //
        // SCOPED TO THIS PROJECTION, not to the app. `MedicationRow` and
        // `MedicationCard` still mount the one-tap for a pooled item with
        // `hasLastFill={med.last_fill_size != null}`, straight into `refillSupply`'s
        // pooled branch; that is live on main and is #5911's, not this module's.
        lastFillSize: null,
      });
  }
  return refillTargets;
}
