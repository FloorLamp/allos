"use client";

import { useId, useState } from "react";
import Button from "@/components/Button";
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

// ONE ROW RENDERER, AHEAD INCLUDED (#4076). Ahead used to draw its own member row
// with its own kind glyph; both are gone. What is left that is Ahead's own is the
// BUCKET: a lead fact, the rest behind a "+N more", and the bucket's door on the
// lead. Read-only by construction — Ahead never mounts a write.
function Member({
  member,
  href,
}: {
  member: DashboardAheadMember;
  href?: AppRoute;
}) {
  return (
    <DashboardFactRow
      candidate={member.candidate}
      presentation={href ? { ...member.presentation, href } : member.presentation}
      lane="ahead"
      className="relative min-w-0"
    />
  );
}

function Bucket({ bucket }: { bucket: DashboardAheadBucket }) {
  const [expanded, setExpanded] = useState(false);
  const contentsId = useId();
  const [first, ...rest] = bucket.members;
  if (!first) return null;
  return (
    <section
      className="band rounded-xl border border-(--border) bg-surface px-4 py-3"
      data-ahead-bucket={bucket.key}
      aria-labelledby={`${contentsId}-label`}
    >
      <h3
        id={`${contentsId}-label`}
        className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
      >
        {bucket.label}
      </h3>
      <div className="flex items-start justify-between gap-3">
        <ul className="min-w-0 flex-1">
          <Member
            member={first}
            href={bucket.primaryHref ?? first.presentation.href}
          />
        </ul>
        {rest.length > 0 && (
          <Button
            aria-label={`+${rest.length} more in ${bucket.label}`}
            aria-expanded={expanded}
            aria-controls={contentsId}
            onClick={() => setExpanded((value) => !value)}
          >
            +{rest.length} more
          </Button>
        )}
      </div>
      {rest.length > 0 && (
        <ul
          id={contentsId}
          hidden={!expanded}
          className="mt-3 space-y-3 border-t border-(--divider) pt-3"
        >
          {rest.map((member) => (
            <Member key={member.candidate.candidateId} member={member} />
          ))}
        </ul>
      )}
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
