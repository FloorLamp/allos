// The mobility-move catalog, loaded onto the curated-dataset framework (issue #860
// Track B) for the mobility log (issue #840). Copies the food-groups.ts shape: import
// the envelope JSON, validate it once with loadDataset(), build a slug-keyed matcher,
// and expose small typed accessors. The public lib/mobility-moves.ts re-exports these;
// the registry lists this dataset for the linter. Pure — no DB, no network.

import rawMobilityMoves from "./data/mobility-moves.json";
import { loadDataset } from "./loader";
import { createMatcher, slugStrategy } from "./matcher";
import type { MobilityMove, MobilityMoveKind } from "@/scripts/gen-mobility-moves";

export type { MobilityMove, MobilityMoveKind };

// The validated dataset (envelope + guarantees). Throws at module load if the committed
// JSON ever violates the contract — a loud, early failure.
export const mobilityMovesDataset = loadDataset<MobilityMove>(rawMobilityMoves);

// Slug-keyed matcher. The refusal gate: a slug not in the catalog resolves to null.
const matcher = createMatcher(mobilityMovesDataset, slugStrategy);

// The catalog in file order (head-to-toe). Callers iterate this for the tap bar,
// coverage strip, etc.
export const MOBILITY_MOVES: MobilityMove[] = mobilityMovesDataset.entries;

// The move for a slug, or undefined for a retired/unknown one.
export function mobilityMoveBySlug(slug: string): MobilityMove | undefined {
  return matcher.match(slug) ?? undefined;
}

export function isValidMobilityMove(slug: string): boolean {
  return matcher.has(slug);
}

// The canonical catalog slug for a raw input, or null for a retired/unknown move.
// PERSIST THIS, never the raw input (#883): every downstream reader (coverage, the
// components list) compares the stored component name EXACTLY against the canonical slug.
export function canonicalMobilityMove(raw: string): string | null {
  return matcher.match(raw)?.slug ?? null;
}

export function mobilityMoveSlugs(): string[] {
  return MOBILITY_MOVES.map((m) => m.slug);
}

// The display name for a slug, falling back to the slug itself for a retired/unknown one
// (the #203 discipline: a logged move under an old slug still renders, never throws).
export function mobilityMoveName(slug: string): string {
  return mobilityMoveBySlug(slug)?.name ?? slug;
}
