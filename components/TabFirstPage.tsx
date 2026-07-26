import type { ReactNode } from "react";
import { NavTabStrip } from "@/components/NavTabs";
import type { TabFirstPageConfig } from "@/components/tab-first-pages";
import { PageHeader } from "@/components/ui";

// Responsive page shell for a small set of top-level views whose tabs ARE the
// mobile page identity. Phones start directly with two-or-more prominent tabs:
// the visible title is redundant with the app chrome + selected tab, but a
// screen-reader H1 remains. Its visible tab strip is registered in ShellChrome,
// so it hides and reveals with the phone nav as one sticky unit. Desktop keeps
// the conventional PageHeader followed by the shared compact NavTabs treatment.
export default function TabFirstPage({
  config,
  children,
  className = "",
  testId,
}: {
  config: TabFirstPageConfig;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { title, tabs, paramKey } = config;

  return (
    <div
      className={`-mt-2 mx-auto w-full md:mt-0 ${className}`}
      data-testid={testId}
    >
      <div
        data-testid={testId ? `${testId}-title` : undefined}
        className="hidden md:block"
      >
        <PageHeader title={title} />
      </div>
      <h1 className="sr-only md:hidden">{title}</h1>
      <div className="hidden md:block">
        <NavTabStrip paramKey={paramKey} tabs={tabs} prominentOnMobile />
      </div>
      <div role="tabpanel">{children}</div>
    </div>
  );
}
