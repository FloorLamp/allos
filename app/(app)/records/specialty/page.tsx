import { redirect } from "next/navigation";
import { requireScope } from "@/lib/scope";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../nav";

export const dynamic = "force-dynamic";

// Bare Specialty group route → its first VISIBLE pane (#1079). Vision/Dental are
// data-gated and Substance use is life-stage-gated, so the landing pane depends on
// relevance (Skin/Mental health always render, so a visible pane always exists).
// Resolved over the VIEW SET since #2557, exactly as the tab strip and the pane
// routes do — three readers of ONE predicate, so they cannot disagree about which
// pane is first.
export default async function RecordsSpecialtyPage() {
  const scope = await requireScope();
  const panes = visibleSpecialtyPanes(
    getRecordsSpecialtyRelevanceForView(scope.actingProfileId, scope.viewIds)
  );
  redirect(panes[0].href);
}
