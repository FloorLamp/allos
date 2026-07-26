import type { NutritionTab } from "@/lib/hrefs";

export interface TabFirstPageConfig {
  pathname: string;
  title: string;
  paramKey: string;
  tabs: readonly { id: string; label: string }[];
}

export const NUTRITION_TAB_FIRST_PAGE = {
  pathname: "/nutrition",
  title: "Nutrition",
  paramKey: "tab",
  tabs: [
    { id: "food", label: "Food" },
    { id: "supplements", label: "Supplements" },
  ] satisfies readonly { id: NutritionTab; label: string }[],
} as const satisfies TabFirstPageConfig;

// Tab-first pages register here once. ShellChrome reads the same configuration
// as the page, so the prominent phone tabs can live in the auto-hiding shell
// while the compact desktop strip stays below its PageHeader.
const TAB_FIRST_PAGES: readonly TabFirstPageConfig[] = [
  NUTRITION_TAB_FIRST_PAGE,
];

export function tabFirstPageForPath(
  pathname: string
): TabFirstPageConfig | undefined {
  return TAB_FIRST_PAGES.find((page) => page.pathname === pathname);
}
