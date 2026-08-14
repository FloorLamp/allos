import PageContainer from "@/components/PageContainer";
import TabFirstPage from "@/components/TabFirstPage";
import { RESULTS_TAB_FIRST_PAGE } from "@/components/tab-first-pages";

// Results (#1079): the Clinical results / Imaging / Reports / Genomics stores as
// route-per-tab (`/results/<tab>`), replacing the #1042 stacked-section page. The
// shared shell — page header + tab strip — lives here so it persists across tab
// navigation; each tab's `page.tsx` is a thin Server Component rendering its one
// section (moved, not rewritten). Bare `/results` redirects to `/results/clinical-results`.

export default function ResultsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PageContainer
      width="wide"
      className="mx-auto"
      data-testid="results-container"
    >
      <TabFirstPage config={RESULTS_TAB_FIRST_PAGE} testId="results-page">
        {children}
      </TabFirstPage>
    </PageContainer>
  );
}
