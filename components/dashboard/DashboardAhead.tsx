import type { AppRoute } from "@/lib/hrefs";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import {
  DashboardFactRow,
  type DashboardStandingPresentation,
} from "./DashboardStandingCluster";

export interface DashboardAheadMember {
  candidate: DashboardPlacement["candidate"];
  presentation: DashboardStandingPresentation;
}

export interface DashboardAheadBucket {
  key: "later-today" | "horizon";
  label: string;
  primaryHref?: AppRoute;
  members: readonly DashboardAheadMember[];
}

// ONE ROW RENDERER, AHEAD INCLUDED (#4076), AND NOW NO FOLD (#4232). Ahead used to
// draw its own member row with its own kind glyph; both are gone. The "+N more"
// button is gone too, with the `useState` behind it — the only ephemeral disclosure
// state on the page, never URL-carried, forgetting itself on every visit. Everything
// in Ahead is by definition relevant-soon, so the bucket renders every member: a lead
// fact carrying the bucket's door, then the rest. Read-only by construction — Ahead
// never mounts a write, which is also why nothing here needs to be a client component.
function Bucket({ bucket }: { bucket: DashboardAheadBucket }) {
  const [first, ...rest] = bucket.members;
  if (!first) return null;
  const labelId = `dashboard-ahead-${bucket.key}-label`;
  return (
    <section
      className="band rounded-xl border border-(--border) bg-surface px-4 py-3"
      data-ahead-bucket={bucket.key}
      aria-labelledby={labelId}
    >
      <h3
        id={labelId}
        className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
      >
        {bucket.label}
      </h3>
      <ul className="flex min-w-0 flex-col gap-1.5">
        <DashboardFactRow
          candidate={first.candidate}
          presentation={
            bucket.primaryHref
              ? { ...first.presentation, href: bucket.primaryHref }
              : first.presentation
          }
          lane="ahead"
          className="relative min-w-0"
        />
        {rest.map((member) => (
          <DashboardFactRow
            key={member.candidate.candidateId}
            candidate={member.candidate}
            presentation={member.presentation}
            lane="ahead"
            className="relative min-w-0"
          />
        ))}
      </ul>
    </section>
  );
}

export default function DashboardAhead({
  buckets,
}: {
  buckets: readonly DashboardAheadBucket[];
}) {
  if (buckets.length === 0) return null;
  return (
    <section
      className="section-seam-lg mb-8"
      aria-labelledby="dashboard-ahead-title"
      data-testid="dashboard-ahead"
    >
      <h2
        id="dashboard-ahead-title"
        className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        Ahead
      </h2>
      <div className="grid grid-cols-1 gap-3">
        {buckets.map((bucket) => (
          <Bucket key={bucket.key} bucket={bucket} />
        ))}
      </div>
    </section>
  );
}
