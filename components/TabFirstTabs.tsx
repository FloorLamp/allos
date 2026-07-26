"use client";

import { NavTabStrip, RouteNavTabsStrip } from "@/components/NavTabs";
import type { TabFirstPageConfig } from "@/components/tab-first-pages";

// One renderer for both URL vocabularies supported by a tab-first page. Query
// tabs and route tabs differ only in how their href and active state are derived;
// their mobile shell and desktop strip must keep the same responsive anatomy.
export default function TabFirstTabs({
  config,
  flush = false,
}: {
  config: TabFirstPageConfig;
  flush?: boolean;
}) {
  const shared = {
    prominentOnMobile: true,
    mobileColumns: config.mobileColumns,
    flush,
    testId: config.testId,
    className: flush ? undefined : config.desktopStripClassName,
  } as const;

  return config.kind === "query" ? (
    <NavTabStrip tabs={config.tabs} paramKey={config.paramKey} {...shared} />
  ) : (
    <RouteNavTabsStrip tabs={config.tabs} {...shared} />
  );
}
