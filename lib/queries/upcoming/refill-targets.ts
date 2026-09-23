// WHAT A LOW-SUPPLY CUE CAN MOUNT THE SHARED REFILL ACTION ON (#5121 §9, #5907).
//
// A pure projection over one profile's already-read intake items, producing one target
// per low-supply cue KEY. The keys are minted by the same two minters the cues
// themselves carry — `refillSignalKey` for a private supply (`refillItems`) and
// `poolRefillSignalKey` for a shared bottle (`poolRefillItems`, in ./intake-safety) —
// so a cue and its control are joined on the identity the producer stamped rather than
// by parsing one back out of a string.
//
// `refillCueTargets` is the one production path: it reads the snapshot-cached
// `getIntakeItems` list (no statement of its own) and a LOW shared bottle's own fill.
// `projectRefillCueTargets` is the pure projection under it, so every claim below is
// checkable against `poolRefillItems` without a page or a request.

import { rememberedFillFor } from "@/lib/refill";
import { poolRefillSignalKey, refillSignalKey } from "@/lib/refill-nudge";
import type { IntakeItem } from "@/lib/types";
import type { UpcomingItem } from "@/lib/upcoming";
import { getIntakeItems } from "../intake/schedule";
import { getSharedSupply } from "../intake/supply-pool";

// One cue's refill target. `supplyId` is the bottle when the cue is a pooled one and
// null for a private supply; `lastFillSize` is the remembered fill, whose ABSENCE is
// what makes the tap ask for a size instead of writing one.
export interface RefillCueTarget {
  itemId: number;
  supplyId: number | null;
  lastFillSize: number | null;
}

// The targets for the refill cues `attention` has raised for this profile. Costs no
// read unless a shared bottle is low, then one per such bottle.
export function refillCueTargets(
  profileId: number,
  attention: readonly UpcomingItem[]
): Map<string, RefillCueTarget> {
  return projectRefillCueTargets(
    getIntakeItems(profileId),
    attention,
    (supplyId) => getSharedSupply(supplyId)?.last_fill_size ?? null
  );
}

// The targets for every cue key this profile's items can raise, private and pooled.
// A pooled target is emitted only for a bottle whose refill cue is in `attention` (it
// is low or due), and only then is `bottleFill` asked for that bottle's OWN remembered
// fill, once per bottle. A private target is not gated that way because it costs no
// read, and the composer admits only a key that is both a raised cue and a target.
export function projectRefillCueTargets(
  items: readonly IntakeItem[],
  attention: readonly UpcomingItem[],
  bottleFill: (supplyId: number) => number | null
): Map<string, RefillCueTarget> {
  const raised = new Set(
    attention.filter((cue) => cue.domain === "refill").map((cue) => cue.key)
  );
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
        lastFillSize: rememberedFillFor({
          supplyId: null,
          itemLastFillSize: item.last_fill_size,
          poolLastFillSize: null,
        }),
      });
      continue;
    }
    // A POOLED BOTTLE IS KEYED ON THE POOL, never on a member (#1374), and its cue
    // names ONE subject. `poolRefillItems` picks this profile's lowest-id member to
    // carry it, so the same pick is made here — the row and its control then act on
    // the same item, and a second member of the same bottle can never mint a rival
    // control for it.
    const poolKey = poolRefillSignalKey(item.supply_id);
    if (!raised.has(poolKey)) continue;
    const seated = refillTargets.get(poolKey);
    if (seated == null || item.id < seated.itemId)
      refillTargets.set(poolKey, {
        itemId: item.id,
        supplyId: item.supply_id,
        // THE BOTTLE'S OWN USUAL REFILL (#5121 owner ruling 2026-09-16), never a
        // member's: the carrier is a position picked to aim an href, and a member's
        // `last_fill_size` may be a fill of a private bottle it had before linking
        // (#5908, #5911). `rememberedFillFor` owns that rule for every surface; a bottle
        // that remembers nothing answers null, so the first tap asks for a size.
        lastFillSize:
          seated != null
            ? seated.lastFillSize
            : rememberedFillFor({
                supplyId: item.supply_id,
                itemLastFillSize: item.last_fill_size,
                poolLastFillSize: bottleFill(item.supply_id),
              }),
      });
  }
  return refillTargets;
}
