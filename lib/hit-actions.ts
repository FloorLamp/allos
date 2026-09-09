// Pure per-hit action matchers for the command palette (issue #662).
//
// searchAll (lib/queries/search.ts) is navigation-only by design; these builders
// converge it with the palette's action registry by attaching a few CONTEXTUAL
// actions to the top result kinds — act on the FOUND entity, not just jump to it.
// Kept pure (no DB/React) so the labels + gating logic are unit-tested in
// lib/__tests__/hit-actions.test.ts; the DB fan-out calls these with the row data
// it already has, and CommandPalette dispatches each `kind` to the EXISTING gated
// Server Action (the write auth gate stays in the action — never a search bypass).

import { FOCUS_PARAM } from "./palette-actions";
import type { IntakeItemKind } from "./types";
import { intakeSupplyHref, type AppRoute } from "./hrefs";
import type { HitAction } from "./search-rank";

// Both intake kinds can refill tracked stock. Only medications offer Log dose.
// A first refill opens the same item's fill-size control.
export function medicationHitActions(
  itemId: number,
  tracksSupply: boolean,
  kind: IntakeItemKind = "medication",
  supplyId: number | null = null
): HitAction[] {
  const actions: HitAction[] =
    kind === "medication"
      ? [{ kind: "log-dose", label: "Log dose", entityId: itemId }]
      : [];
  if (tracksSupply) {
    actions.push({
      kind: "refill",
      supplyId,
      label: "Refill",
      entityId: itemId,
      href: intakeSupplyHref(kind, itemId, true),
    });
  }
  return actions;
}

// An appointment hit offers "Mark complete" ONLY while it is still scheduled — a
// completed or cancelled appointment has nothing to complete, and re-completing
// would be a confusing no-op. Mirrors completeAppointment's own scoping.
export function appointmentHitActions(id: number, status: string): HitAction[] {
  if (status !== "scheduled") return [];
  return [{ kind: "complete", label: "Mark complete", entityId: id }];
}

// A clinical-result hit offers "Add result": a NAVIGATE action to the Clinical results add
// form, name-prefilled with this analyte's canonical name (ResultForm reads the
// `name` param in add mode) and carrying the palette focus param so the form opens
// focused. No write happens from search — the user fills value/date/unit and the
// existing addResult action gates + writes it.
export function clinicalResultHitActions(canonicalName: string): HitAction[] {
  const href: AppRoute = `/results/clinical-results?${FOCUS_PARAM}=1&name=${encodeURIComponent(
    canonicalName
  )}`;
  return [{ kind: "add-result", label: "Add result", entityId: 0, href }];
}
