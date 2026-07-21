import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../nav";

export const dynamic = "force-dynamic";

// Bare Specialty group route → its first VISIBLE pane (#1079). Vision/Dental are
// data-gated, so the landing pane depends on relevance (Skin/Mental health always
// render, so a visible pane always exists).
export default async function RecordsSpecialtyPage() {
  const { profile } = await requireSession();
  const relevance = getNavRelevance(profile.id);
  const panes = visibleSpecialtyPanes({
    vision: relevance.vision,
    dental: relevance.dental,
  });
  redirect(panes[0].href);
}
