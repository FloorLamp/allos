import TabFirstPage from "@/components/TabFirstPage";
import { NUTRITION_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { NUTRITION_TABS, type NutritionTab } from "@/lib/hrefs";
import { isRealIsoDate } from "@/lib/date";
import FoodTab from "./FoodTab";
import SupplementsTab from "./SupplementsTab";

export const dynamic = "force-dynamic";

// The Nutrition umbrella (#746): a URL-driven Food | Supplements tab strip (the
// Trends/Data/Settings precedent — one panel resolved server-side per request, not
// every panel mounted). The strip and active panel stay at page level; each Food or
// Supplements section owns its own card hierarchy. Medications remain on their own
// Medical-group page; the old /medicine route was removed (#1635).
//
// The infant gate (issue #591/#746) lives on the FOOD tab only — infant supplements
// (vitamin D drops) are real, so the Supplements tab is always reachable and the nav
// entry stays visible when the profile tracks any intake item.

function parseTab(value: string | string[] | undefined): NutritionTab {
  const first = Array.isArray(value) ? value[0] : value;
  return NUTRITION_TABS.includes(first as NutritionTab)
    ? (first as NutritionTab)
    : "food";
}

export default async function NutritionPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const tab = parseTab(searchParams.tab);

  // `?supply=` (#1705) is the cabinet's "Add for another person" deep link. Parsed here
  // with the tab, resolved (and access-checked) inside the tab that uses it.
  const rawSupply = Array.isArray(searchParams.supply)
    ? searchParams.supply[0]
    : searchParams.supply;
  const rawDate = one(searchParams.date);
  const rawBackfill = one(searchParams.backfill);
  const activePanel =
    tab === "supplements" ? (
      <SupplementsTab
        supplyId={Number(rawSupply ?? 0)}
        backfillDate={isRealIsoDate(rawBackfill) ? rawBackfill : undefined}
      />
    ) : (
      <FoodTab initialDate={isRealIsoDate(rawDate) ? rawDate : undefined} />
    );

  return (
    <TabFirstPage
      config={NUTRITION_TAB_FIRST_PAGE}
      className="xl:max-w-6xl"
      testId="nutrition-page"
    >
      {activePanel}
    </TabFirstPage>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
