import { requireSession } from "@/lib/auth";
import BiomarkersSection, {
  type BiomarkersSearchParams,
} from "../BiomarkersSection";

export const dynamic = "force-dynamic";

// Results › Biomarkers (#1079): the filterable analyte browser + BioAge hero +
// starred tiles + add form, on its own route so its searchparams namespace
// (`?q/?category/?panel/?range/?sort/?dir/?current/?p/?new/?name`) stays clean.
// Content component moved, not rewritten.
export default async function ResultsBiomarkersPage(props: {
  searchParams: Promise<BiomarkersSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  return (
    <div data-testid="results-biomarkers">
      <BiomarkersSection profileId={profile.id} searchParams={searchParams} />
    </div>
  );
}
