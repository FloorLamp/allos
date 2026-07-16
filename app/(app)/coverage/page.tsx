import { requireSession } from "@/lib/auth";
import { PageHeader, EmptyState } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import { getCoverageGaps, getCoverageGapCandidates } from "@/lib/queries";
import { aiEndpointInfo } from "@/lib/ai-client";
import { buildCatalogRequest } from "@/lib/coverage-gaps";
import CoverageGaps from "@/components/CoverageGaps";

export const dynamic = "force-dynamic";

// Coverage gaps (issue #550). When a profile has a biomarker/med/condition the
// curated catalogs don't cover, this page surfaces it and offers two fill paths:
// private/local AI descriptive context, or a de-identified maintainer catalog
// request the user reviews and files. A tracked gap the catalog later covers shows
// a "now available" state (computed live against the current catalogs).
export default async function CoveragePage() {
  const { profile } = await requireSession();
  const tracked = getCoverageGaps(profile.id);
  const candidates = getCoverageGapCandidates(profile.id);
  const ai = aiEndpointInfo();

  // Precompute the de-identified request artifacts server-side (pure, no PHI) so
  // the client can copy/open without re-deriving. Keyed by gap id.
  const requests = Object.fromEntries(
    tracked.map((g) => [g.id, buildCatalogRequest(g.kind, g.label, g.itemKey)])
  );

  return (
    <PageContainer width="reading" className="mx-auto">
      <PageHeader
        title="Coverage gaps"
        subtitle="Biomarkers, medications, and conditions the curated catalogs don't cover yet — track one to add context or request it be catalogued."
      />

      {tracked.length === 0 && candidates.length === 0 ? (
        <EmptyState message="No coverage gaps — everything you've logged is covered by the curated catalogs." />
      ) : (
        <CoverageGaps
          tracked={tracked}
          candidates={candidates}
          requests={requests}
          aiConfigured={ai.configured}
          aiLabel={ai.label}
        />
      )}

      <p className="mt-8 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        AI-generated context is descriptive only and{" "}
        <span className="font-medium">unverified</span> — it never sets a
        reference range, flag, or interaction. Curated data drives all clinical
        logic. Informational, not medical advice.
      </p>
    </PageContainer>
  );
}
