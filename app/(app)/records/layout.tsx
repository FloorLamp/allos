import { requireSession } from "@/lib/auth";
import { getRecordsSpecialtyRelevance } from "@/lib/queries/nav-relevance";
import { PageHeader } from "@/components/ui";
import type { AppRoute } from "@/lib/hrefs";
import AnchorRedirect from "@/components/AnchorRedirect";
import RecordsTabs from "./RecordsTabs";
import { recordsGroups } from "./nav";

export const dynamic = "force-dynamic";

// Health record (#1079): the 14 medical sections as two-level tabs — group tab →
// section sub-tab → one pane — replacing the #1042 stacked-section page. The shared
// shell (header + two-level tab strip) lives here so it persists across tab
// navigation; each pane's `page.tsx` renders its one section (or, for a stacked
// pane, its 2–4 light section components). The data-gated Specialty set is resolved
// here (getNavRelevance) and passed to the strip, so a hidden Vision/Dental sub-tab
// and its (re-gated) route agree. Bare `/records` redirects to
// `/records/history/visits`.

// Old `/records#<section>` bookmarks land on a route-per-tab page whose hash no
// longer names a section — bridge them client-side (a fragment never reaches the
// server, so next.config can't). `#emergency-card` now bridges to the Passport,
// where the Emergency Card settings moved (#1087). `#coverage` still bridges to
// Data (#1086).
const ANCHOR_MAP: Record<string, AppRoute> = {
  conditions: "/records/problems",
  allergies: "/records/problems",
  procedures: "/records/history/procedures",
  immunizations: "/records/history/immunizations",
  visits: "/records/history/visits",
  providers: "/records/care/providers",
  background: "/records/care/overview",
  "emergency-card": "/profile#emergency",
  "family-history": "/records/care/overview",
  "care-plan": "/records/care/overview",
  "health-goals": "/records/care/overview",
  vision: "/records/specialty/vision",
  dental: "/records/specialty/dental",
  skin: "/records/specialty/skin",
  "mental-health": "/records/specialty/mental-health",
  "substance-use": "/records/specialty/substance-use",
  coverage: "/data?section=coverage",
};

export default async function RecordsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile } = await requireSession();
  const groups = recordsGroups(getRecordsSpecialtyRelevance(profile.id));
  return (
    <div>
      <AnchorRedirect map={ANCHOR_MAP} />
      <PageHeader
        title="Health record"
        subtitle="Your health record in one place — history, problems, care, and specialty records."
      />
      <RecordsTabs groups={groups} />
      {children}
    </div>
  );
}
