"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { AppRoute } from "@/lib/hrefs";
import type { DashboardCandidateKind } from "@/lib/dashboard-relevance";
import CandidateKindGlyph from "./CandidateKindGlyph";

export interface DashboardAheadMember {
  candidateId: string;
  factKey: string;
  // The candidate's kind, for its glyph (#3253 decision 3). Ahead members are cards
  // in the same sense Now's are — they act, they do not report a reading — so each
  // carries exactly one.
  kind: DashboardCandidateKind;
  label: string;
  detail?: string;
  href?: AppRoute;
}

export interface DashboardAheadBucket {
  key: "later-today" | "horizon";
  label: string;
  primaryHref?: AppRoute;
  members: readonly DashboardAheadMember[];
}

function Member({
  member,
  href = member.href,
}: {
  member: DashboardAheadMember;
  href?: AppRoute;
}) {
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <CandidateKindGlyph
          kind={member.kind}
          className="mt-0 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
        />
        <span className="truncate font-medium text-slate-800 dark:text-slate-100">
          {member.label}
        </span>
      </span>
      {member.detail && (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {member.detail}
        </span>
      )}
    </>
  );
  return (
    <div
      data-testid="dashboard-candidate"
      data-candidate-id={member.candidateId}
      data-fact-key={member.factKey}
      data-lane="ahead"
      className="min-w-0"
    >
      {href ? (
        <Link href={href} className="flex min-w-0 flex-col gap-0.5">
          {content}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-col gap-0.5">{content}</div>
      )}
    </div>
  );
}

function Bucket({ bucket }: { bucket: DashboardAheadBucket }) {
  const [expanded, setExpanded] = useState(false);
  const contentsId = useId();
  const [first, ...rest] = bucket.members;
  if (!first) return null;
  return (
    <section
      className="rounded-xl border border-(--border) bg-surface px-4 py-3"
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
        <Member member={first} href={bucket.primaryHref ?? first.href} />
        {rest.length > 0 && (
          <button
            type="button"
            className="shrink-0 text-sm font-medium text-brand-700 dark:text-brand-400"
            aria-label={`+${rest.length} more in ${bucket.label}`}
            aria-expanded={expanded}
            aria-controls={contentsId}
            onClick={() => setExpanded((value) => !value)}
          >
            +{rest.length} more
          </button>
        )}
      </div>
      {rest.length > 0 && (
        <ul
          id={contentsId}
          hidden={!expanded}
          className="mt-3 space-y-3 border-t border-(--divider) pt-3"
        >
          {rest.map((member) => (
            <li key={member.candidateId}>
              <Member member={member} />
            </li>
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
      className="mb-8"
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
