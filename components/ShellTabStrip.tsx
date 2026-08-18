"use client";

import { usePathname } from "next/navigation";
import TabFirstTabs from "@/components/TabFirstTabs";
import {
  tabFirstPageForPath,
  type TabFirstPageConfig,
} from "@/components/tab-first-pages";

// The phone form of a tab-first page belongs to the app chrome, not to the
// scrolling content below it. Rendering it inside ShellChrome makes the nav and
// tabs one sticky, auto-hiding unit. The desktop copy is responsive-exclusive
// and remains beside the page content where desktop page hierarchy expects it.
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
      <TabFirstTabs config={config} flush />
    </div>
  );
}
