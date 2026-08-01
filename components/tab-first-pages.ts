import type { AppRoute, NutritionTab } from "@/lib/hrefs";
import { trainingTabStrip } from "@/lib/training-tabs";

interface TabFirstPageBase {
  pageId: "nutrition" | "results" | "training";
  title: string;
  subtitle?: string;
  mobileColumns: 2 | 3 | 4;
  mobileLayout?: "equal" | "scroll";
  testId?: string;
  desktopStripClassName?: string;
}

export interface QueryTabFirstPageConfig extends TabFirstPageBase {
  kind: "query";
  pathname: string;
  paramKey: string;
  tabs: readonly { id: string; label: string }[];
}

export interface RouteTabFirstPageConfig extends TabFirstPageBase {
  kind: "route";
  pathnamePrefix: string;
  tabs: readonly { href: AppRoute; label: string }[];
}

export type TabFirstPageConfig =
  QueryTabFirstPageConfig | RouteTabFirstPageConfig;

export const NUTRITION_TAB_FIRST_PAGE = {
  pageId: "nutrition",
  kind: "query",
  pathname: "/nutrition",
  title: "Nutrition",
  paramKey: "tab",
  mobileColumns: 2,
  tabs: [
    { id: "food", label: "Food" },
    { id: "supplements", label: "Supplements" },
  ] satisfies readonly { id: NutritionTab; label: string }[],
} as const satisfies TabFirstPageConfig;

export const RESULTS_TAB_FIRST_PAGE = {
  pageId: "results",
  kind: "route",
  pathnamePrefix: "/results",
  title: "Results",
  mobileColumns: 4,
  testId: "results-tabs",
  desktopStripClassName: "mb-6",
  tabs: [
    { href: "/results/biomarkers", label: "Biomarkers" },
    { href: "/results/imaging", label: "Imaging" },
    { href: "/results/reports", label: "Reports" },
    { href: "/results/genomics", label: "Genomics" },
  ],
} as const satisfies TabFirstPageConfig;

export const TRAINING_TAB_FIRST_PAGE = {
  pageId: "training",
  kind: "query",
  pathname: "/training",
  title: "Training",
  subtitle: "Review workouts, compare progress, and manage training goals.",
  paramKey: "tab",
  mobileColumns: 2,
  mobileLayout: "scroll",
  testId: "training-tabs",
  tabs: trainingTabStrip(),
} as const satisfies TabFirstPageConfig;

// Tab-first pages register here once. ShellChrome reads the same configuration
// as the page, so the prominent phone tabs can live in the auto-hiding shell
// while the compact desktop strip stays below its PageHeader.
const TAB_FIRST_PAGES: readonly TabFirstPageConfig[] = [
  NUTRITION_TAB_FIRST_PAGE,
  RESULTS_TAB_FIRST_PAGE,
  TRAINING_TAB_FIRST_PAGE,
];

export function tabFirstPageForPath(
  pathname: string
): TabFirstPageConfig | undefined {
  return TAB_FIRST_PAGES.find((page) =>
    page.kind === "query"
      ? page.pathname === pathname
      : pathname === page.pathnamePrefix ||
        pathname.startsWith(`${page.pathnamePrefix}/`)
  );
}
