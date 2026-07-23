import { EmptyState } from "@/components/ui";
import { getCoverageGaps, getCoverageGapCandidates } from "@/lib/queries";
import { taskEndpointInfo } from "@/lib/ai-resolve";
import { buildCatalogRequest } from "@/lib/coverage-gaps";
import CoverageGaps from "@/components/CoverageGaps";

// Coverage gaps (issue #550; former /coverage index, #1042 phase 6, briefly the
// #coverage section of /records), now the Coverage tab of /data (#1086). Coverage
// gaps is a catalog / data-management workflow about the APP's coverage of your
// data — not a clinical record — so it lives under Data, alongside Import/Review.
// When a profile has a biomarker/med/condition the curated catalogs don't cover,
// this surfaces it and offers two fill paths: private/local AI descriptive context,
// or a de-identified maintainer catalog request the user reviews and files. A
// tracked gap the catalog later covers shows a "now available" state (computed live
// against the current catalogs).
export default function CoverageSection({ profileId }: { profileId: number }) {
  const tracked = getCoverageGaps(profileId);
  const candidates = getCoverageGapCandidates(profileId);
  // The coverage blurb runs on the Light tier (falling back to Heavy) — show the
  // backend that would actually serve it.
  const ai = taskEndpointInfo("coverage");

  // Precompute the de-identified request artifacts server-side (pure, no PHI) so
  // the client can copy/open without re-deriving. Keyed by gap id.
  const requests = Object.fromEntries(
    tracked.map((g) => [g.id, buildCatalogRequest(g.kind, g.label, g.itemKey)])
  );

  return (
    <div data-testid="data-coverage">
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
        logic.
      </p>
    </div>
  );
}
