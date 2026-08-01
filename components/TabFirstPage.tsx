import type { ReactNode } from "react";
import TabFirstTabs from "@/components/TabFirstTabs";
import type { TabFirstPageConfig } from "@/components/tab-first-pages";
import { PageHeader } from "@/components/ui";

// Responsive page shell for a small set of top-level views whose tabs ARE the
// mobile page identity. Phones start directly with two-or-more prominent tabs:
// the visible title is redundant with the app chrome + selected tab, but a
// screen-reader H1 remains. Its visible tab strip is registered in ShellChrome,
// so it hides and reveals with the phone nav as one sticky unit. Desktop keeps
// the conventional PageHeader followed by the shared compact NavTabs treatment.
//
// THE HEADER ACTION IS NOT PART OF THE HEADING BAND (#1661). It used to be passed
// into PageHeader, which lives inside the `hidden md:block` heading block — so a
// tab-first page's header action simply did not exist below `md`, and Training's
// Equipment link was the casualty: on a phone there was no door from Training to
// the equipment registry at all. What #1616 dropped on phones is read-once
// heading COPY (a title the chrome already names, and orientation prose); a door
// to another surface is neither.
//
// So the action is rendered ONCE, in its own flex cell beside the heading block
// rather than inside it — a single DOM node that survives the heading band's
// disappearance instead of a second phone-only copy of the same control. From
// `md` up it bottom-aligns with the heading exactly as PageHeader's own action
// slot did; below `md` the heading cell is gone and it becomes the tab body's
// toolbar row, right-aligned above the panel.
export default function TabFirstPage({
  config,
  children,
  action,
  className = "",
  testId,
}: {
  config: TabFirstPageConfig;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { title, subtitle } = config;

  return (
    <div
      className={`-mt-2 mx-auto w-full md:mt-0 ${className}`}
      data-testid={testId}
    >
      <div className="flex items-end justify-between gap-4">
        <div
          data-testid={testId ? `${testId}-title` : undefined}
          className="hidden min-w-0 flex-1 md:block"
        >
          <PageHeader title={title} subtitle={subtitle} />
        </div>
        {action && (
          <div
            data-testid={testId ? `${testId}-action` : undefined}
            // Full-width right-aligned row on a phone (the heading cell is gone);
            // a shrink-proof cell on desktop, with PageHeader's own bottom margin
            // mirrored so the two bottom edges still line up.
            className="mb-3 flex w-full shrink-0 justify-end sm:mb-4 md:mb-6 md:w-auto"
          >
            {action}
          </div>
        )}
      </div>
      <h1 className="sr-only md:hidden">{title}</h1>
      <div className="hidden md:block">
        <TabFirstTabs config={config} />
      </div>
      <div role="tabpanel">{children}</div>
    </div>
  );
}
