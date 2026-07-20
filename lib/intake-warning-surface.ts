import type { InteractionHit } from "@/lib/drug-interactions";
import type { PgxHit } from "@/lib/pgx";
import type { SupplementKind } from "@/lib/types";

// Safety findings are computed over the whole active intake stack, but each intake
// surface should show only findings that involve one of its own items. A cross-kind
// interaction therefore appears on BOTH surfaces; a medication×medication finding
// appears only on Medications; a supplement×supplement finding only on Supplements.
// PGx hits carry the affected medication id, so the same id-membership rule naturally
// keeps them off the Supplements surface.
export function intakeWarningsForSurface(
  kind: SupplementKind,
  items: readonly { id: number; kind: SupplementKind }[],
  interactionWarnings: readonly InteractionHit[],
  pgxWarnings: readonly PgxHit[]
): { interactionWarnings: InteractionHit[]; pgxWarnings: PgxHit[] } {
  const itemIds = new Set(
    items.filter((item) => item.kind === kind).map((item) => item.id)
  );

  return {
    interactionWarnings: interactionWarnings.filter(
      (hit) => itemIds.has(hit.aId) || itemIds.has(hit.bId)
    ),
    pgxWarnings: pgxWarnings.filter((hit) => itemIds.has(hit.medId)),
  };
}
