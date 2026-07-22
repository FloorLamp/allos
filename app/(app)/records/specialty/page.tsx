import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getRecordsSpecialtyRelevance } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../nav";

export const dynamic = "force-dynamic";

// Bare Specialty group route → its first VISIBLE pane (#1079). Vision/Dental are
// data-gated and Substance use is life-stage-gated, so the landing pane depends on
// relevance (Skin/Mental health always render, so a visible pane always exists).
export default async function RecordsSpecialtyPage() {
  const { profile } = await requireSession();
  const panes = visibleSpecialtyPanes(getRecordsSpecialtyRelevance(profile.id));
  redirect(panes[0].href);
}
