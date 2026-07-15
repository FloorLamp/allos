import { PageHeader } from "@/components/ui";
import NavTabs from "@/components/NavTabs";
import { NUTRITION_TABS, type NutritionTab } from "@/lib/hrefs";
import FoodTab from "./FoodTab";
import SupplementsTab from "./SupplementsTab";

export const dynamic = "force-dynamic";

// The Nutrition umbrella (#746): a URL-driven Food | Supplements tab strip (the
// Trends/Data/Settings precedent — one panel resolved server-side per request, not
// every panel mounted). Food is the food-group serving log (habit tier); Supplements
// is the former /medicine supplement surface folded in as a tab. Medications left for
// their own Medical-group page; /medicine redirects to ?tab=supplements.
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
    <div>
      <PageHeader
        title="Nutrition"
        subtitle="Food-group servings and your supplement schedule — one habit-tier home."
      />
      <NavTabs
        paramKey="tab"
        tabs={[
          { id: "food", label: "Food" },
          { id: "supplements", label: "Supplements" },
        ]}
      >
        {activePanel}
      </NavTabs>
    </div>
  );
}
