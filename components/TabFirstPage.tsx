import type { ReactNode } from "react";
import TabFirstTabs from "@/components/TabFirstTabs";
import type { CreateActionElement } from "@/components/CreateAction";
import type { TabFirstPageConfig } from "@/components/tab-first-pages";
import { PageHeader } from "@/components/ui";

// Tabs live in ShellChrome on phones and beside the visible desktop heading.
// The action stays outside that responsive heading band (#1661).
export default function TabFirstPage({
  config,
  children,
  action,
  createAction,
  className = "",
  testId,
}: {
  config: TabFirstPageConfig;
  children: ReactNode;
  /** The page's one registered create. Unrelated doors stay in `action`. */
  createAction?: CreateActionElement;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { title, subtitle } = config;
  // `available` is declaration data, so this Server Component can omit the
  // action row without calling through the client boundary.
  const createAvailable = Boolean(
    createAction && createAction.props.available !== false
  );
  const hasTrailing = Boolean(createAvailable || action);

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
        {hasTrailing && (
          <div
            data-testid={testId ? `${testId}-action` : undefined}
            // Full-width right-aligned row on a phone (the heading cell is gone);
            // a shrink-proof cell on desktop, with PageHeader's own bottom margin
            // mirrored so the two bottom edges still line up.
            className="mb-3 flex w-full shrink-0 justify-end sm:mb-4 md:mb-6 md:w-auto"
          >
            <div className="flex items-center gap-3">
              {createAvailable && createAction ? createAction : null}
              {action}
            </div>
          </div>
        )}
      </div>
      <h1 className="sr-only md:hidden">{title}</h1>
      <div className="mb-4 hidden md:block">
        <TabFirstTabs config={config} />
      </div>
      <div
        id={`${config.pageId}-tabpanel`}
        role="tabpanel"
        aria-label={`${title} section`}
      >
        {children}
      </div>
    </div>
  );
}
