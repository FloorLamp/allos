import TabFirstPage from "@/components/TabFirstPage";
import { NUTRITION_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { NUTRITION_TABS, type NutritionTab } from "@/lib/hrefs";
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

  const activePanel = tab === "supplements" ? <SupplementsTab /> : <FoodTab />;

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
