import TabList from "@/components/TabList";
import type { TabFirstPageConfig } from "@/components/tab-first-pages";

export default function TabFirstTabs({
  config,
}: {
  config: TabFirstPageConfig;
}) {
  const shared = {
    binding: "link",
    ariaLabel: `${config.title} sections`,
    panelId: `${config.pageId}-tabpanel`,
    testId: config.testId,
    presentation: {
      kind: "prominent",
      mobileColumns: config.mobileColumns,
      mobileLayout: config.mobileLayout,
    },
  } as const;

  return config.kind === "query" ? (
    <TabList tabs={config.tabs} paramKey={config.paramKey} {...shared} />
  ) : (
    <TabList
      tabs={config.tabs.map((tab) => ({ ...tab, id: tab.href }))}
      {...shared}
    />
  );
}
