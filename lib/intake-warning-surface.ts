import type { InteractionHit } from "@/lib/drug-interactions";
import type { PgxHit } from "@/lib/pgx";
import type { OtotoxicHit } from "@/lib/ototoxic";
import type { DrugAllergyHit } from "@/lib/drug-allergy";
import type { IntakeItemKind } from "@/lib/types";

// Safety findings are computed over the whole active intake stack, but each intake
// surface should show only findings that involve one of its own items. A cross-kind
// interaction therefore appears on BOTH surfaces; a medication×medication finding
// appears only on Medications; a supplement×supplement finding only on Supplements.
// PGx hits carry the affected medication id, so the same id-membership rule naturally
// keeps them off the Supplements surface.
export function intakeWarningsForSurface(
  kind: IntakeItemKind,
  items: readonly { id: number; kind: IntakeItemKind }[],
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

// Every finding of the four kinds that this ONE item is party to (issue #2795). The
// same id-membership rule as above, narrowed from "this surface's items" to a single
// item, so a medication's own detail page can show the interactions the list page
// already shows for it — the one page a person reads before taking a specific drug was
// the one page that never mentioned that drug's interactions.
//
// An interaction is symmetric: it belongs to BOTH of its items, so each partner's page
// shows it. The findings are not recomputed here — this filters the whole-stack results
// the surface already gathered, so a detail page can never disagree with the list about
// what was found or which dedupeKey it carries.
export function intakeWarningsForItem(
  itemId: number,
  warnings: {
    interactionWarnings: readonly InteractionHit[];
    pgxWarnings: readonly PgxHit[];
    ototoxicWarnings: readonly OtotoxicHit[];
    allergyWarnings: readonly DrugAllergyHit[];
  }
): {
  interactionWarnings: InteractionHit[];
  pgxWarnings: PgxHit[];
  ototoxicWarnings: OtotoxicHit[];
  allergyWarnings: DrugAllergyHit[];
} {
  return {
    interactionWarnings: warnings.interactionWarnings.filter(
      (hit) => hit.aId === itemId || hit.bId === itemId
    ),
    pgxWarnings: warnings.pgxWarnings.filter((hit) => hit.medId === itemId),
    ototoxicWarnings: warnings.ototoxicWarnings.filter(
      (hit) => hit.medId === itemId
    ),
    allergyWarnings: warnings.allergyWarnings.filter(
      (hit) => hit.medId === itemId
    ),
  };
}
