import { requireScope } from "@/lib/scope";
import BiomarkersSection, {
  type BiomarkersSearchParams,
} from "../BiomarkersSection";

export const dynamic = "force-dynamic";

// Results › Biomarkers (#1079): the filterable analyte browser + BioAge hero +
// starred tiles + add form, on its own route so its searchparams namespace
// (`?q/?category/?panel/?range/?sort/?dir/?current/?p/?new/?name`) stays clean.
// Multi-view (#1331): resolve the cross-profile scope once at the boundary so the
// table merges per-member partitions when several profiles are in view; a
// single-profile view (scope.viewIds = [acting]) renders byte-identical.
export default async function ResultsBiomarkersPage(props: {
  searchParams: Promise<BiomarkersSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  return (
    <div data-testid="results-biomarkers">
      <BiomarkersSection scope={scope} searchParams={searchParams} />
    </div>
  );
}
