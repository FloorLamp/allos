import type { AppRoute, NutritionTab } from "@/lib/hrefs";
import { trainingTabStrip } from "@/lib/training-tabs";

interface TabFirstPageBase {
  pageId: "data" | "nutrition" | "records" | "results" | "training";
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

export const DATA_TAB_FIRST_PAGE = {
  pageId: "data",
  kind: "query",
  pathname: "/data",
  title: "Data",
  subtitle:
    "Bring data in — upload documents, paste logs, or connect a device — then browse, manage, and export everything you've logged.",
  paramKey: "section",
  // Five tabs, one of them two words: the equal-width grid tops out at four and
  // would crush "Manage & export", so this is the scrolling strip Training uses.
  // `mobileColumns` is inert under `mobileLayout: "scroll"` and only satisfies
  // the shared base type.
  mobileColumns: 4,
  mobileLayout: "scroll",
  testId: "data-tabs",
  tabs: [
    { id: "import", label: "Import" },
    // Deliberately NO unresolved-item count here (it used to read "Review (3)").
    // A tab-first config is rendered from the PATH ALONE by ShellChrome's client
    // strip, which has no server data — so a count could only ever appear on the
    // desktop copy, and one width silently showing a different label is worse
    // than neither showing it. The number is not lost: #1801 put it on the Data
    // nav entry's badge, which is the surface that owns it, and that badge is
    // visible on both widths including while you are on this page.
    { id: "review", label: "Review" },
    { id: "coverage", label: "Coverage" },
    { id: "manage", label: "Manage & export" },
    { id: "trash", label: "Trash" },
  ],
} as const satisfies TabFirstPageConfig;

export const NUTRITION_TAB_FIRST_PAGE = {
  pageId: "nutrition",
  kind: "query",
  pathname: "/nutrition",
  title: "Nutrition",
  subtitle: "Log what you eat and manage the supplements you take.",
  paramKey: "tab",
  mobileColumns: 2,
  tabs: [
    { id: "food", label: "Food" },
    { id: "supplements", label: "Supplements" },
  ] satisfies readonly { id: NutritionTab; label: string }[],
} as const satisfies TabFirstPageConfig;

export const RECORDS_TAB_FIRST_PAGE = {
  pageId: "records",
  kind: "route",
  pathnamePrefix: "/records",
  title: "Health record",
  subtitle:
    "Your health record in one place — history, problems, care, and specialty records.",
  mobileColumns: 4,
  testId: "records-group-tabs",
  desktopStripClassName: "mb-2",
  tabs: [
    { href: "/records/history", label: "History" },
    { href: "/records/problems", label: "Problems" },
    { href: "/records/care", label: "Care" },
    { href: "/records/specialty", label: "Specialty" },
  ],
} as const satisfies TabFirstPageConfig;

export const RESULTS_TAB_FIRST_PAGE = {
  pageId: "results",
  kind: "route",
  pathnamePrefix: "/results",
  title: "Results",
  subtitle:
    "Lab results, imaging studies, narrative reports, and genomics in one place.",
  mobileColumns: 4,
  testId: "results-tabs",
  desktopStripClassName: "mb-6",
  tabs: [
    { href: "/results/clinical-results", label: "Clinical results" },
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
  DATA_TAB_FIRST_PAGE,
  NUTRITION_TAB_FIRST_PAGE,
  RECORDS_TAB_FIRST_PAGE,
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
