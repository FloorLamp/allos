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
import type { AppRoute } from "./hrefs";
import type { HitAction } from "./search-rank";

// A medication hit (an intake_items row with kind='medication') offers "Log dose"
// always, and "Refill" only when the item tracks supply (quantity_on_hand set) —
// refilling an untracked med is a no-op the action would reject, so we don't offer
// it. Supplements (kind='supplement') get no palette actions: the issue scopes this
// to the three named kinds (med / appointment / biomarker), and a supplement's
// stack/UL context lives on its own tab.
export function medicationHitActions(
  itemId: number,
  tracksSupply: boolean
): HitAction[] {
  const actions: HitAction[] = [
    { kind: "log-dose", label: "Log dose", entityId: itemId },
  ];
  if (tracksSupply) {
    actions.push({ kind: "refill", label: "Refill", entityId: itemId });
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

// A biomarker hit offers "Add result": a NAVIGATE action to the Biomarkers add
// form, name-prefilled with this analyte's canonical name (RecordForm reads the
// `name` param in add mode) and carrying the palette focus param so the form opens
// focused. No write happens from search — the user fills value/date/unit and the
// existing addRecord action gates + writes it.
export function biomarkerHitActions(canonicalName: string): HitAction[] {
  const href: AppRoute = `/results?${FOCUS_PARAM}=1&name=${encodeURIComponent(
    canonicalName
  )}#biomarkers`;
  return [{ kind: "add-result", label: "Add result", entityId: 0, href }];
}
