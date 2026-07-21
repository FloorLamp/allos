import { PageHeader } from "@/components/ui";
import type { AppRoute } from "@/lib/hrefs";
import AnchorRedirect from "@/components/AnchorRedirect";
import ResultsTabs from "./ResultsTabs";

// Results (#1079): the Biomarkers / Imaging / Genomics result stores as
// route-per-tab (`/results/<tab>`), replacing the #1042 stacked-section page. The
// shared shell — page header + tab strip — lives here so it persists across tab
// navigation; each tab's `page.tsx` is a thin Server Component rendering its one
// section (moved, not rewritten). Bare `/results` redirects to `/results/biomarkers`.

// Old `/results#<section>` bookmarks land on a route-per-tab page whose hash no
// longer names a section — bridge them client-side (fragments never reach the
// server, so next.config can't). `#add-result` is intentionally NOT mapped: it's an
// in-page anchor on the Biomarkers tab itself (the add-form's id), reached with a
// `?new=1&name=` prefill — mapping it would strip that query.
const ANCHOR_MAP: Record<string, AppRoute> = {
  biomarkers: "/results/biomarkers",
  imaging: "/results/imaging",
  genomics: "/results/genomics",
};

export default function ResultsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <AnchorRedirect map={ANCHOR_MAP} />
      <PageHeader
        title="Results"
        subtitle="Your result records in one place — labs and biomarkers, imaging studies, and genomic variants."
      />
      <ResultsTabs />
      {children}
    </div>
  );
}
