"use client";

import { usePathname } from "next/navigation";
import TabFirstTabs from "@/components/TabFirstTabs";
import {
  tabFirstPageForPath,
  type TabFirstPageConfig,
} from "@/components/tab-first-pages";

// The phone copy lives in chrome; the page owns the desktop copy.
export default function ShellTabStrip({
  disabledPageIds = [],
}: {
  disabledPageIds?: readonly TabFirstPageConfig["pageId"][];
}) {
  const pathname = usePathname();
  const config = tabFirstPageForPath(pathname);

  if (!config || disabledPageIds.includes(config.pageId)) return null;

  return (
    <div data-testid="shell-tab-strip" className="bg-(--nav) md:hidden">
      <TabFirstTabs config={config} />
    </div>
  );
}
