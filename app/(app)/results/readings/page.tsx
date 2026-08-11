import { requireScope } from "@/lib/scope";
import ReadingsSection, { type ReadingsSearchParams } from "../ReadingsSection";

export const dynamic = "force-dynamic";

// Results › Readings (#1079): the filterable clinical-observation browser + BioAge hero +
// starred tiles + add form, on its own route so its searchparams namespace
// (`?q/?category/?panel/?range/?sort/?dir/?current/?p/?new/?name`) stays clean.
// Multi-view (#1331): resolve the cross-profile scope once at the boundary so the
// table merges per-member partitions when several profiles are in view; a
// single-profile view (scope.viewIds = [acting]) renders byte-identical.
export default async function ResultsReadingsPage(props: {
  searchParams: Promise<ReadingsSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  return (
    <div data-testid="results-readings">
      <ReadingsSection scope={scope} searchParams={searchParams} />
    </div>
  );
}
