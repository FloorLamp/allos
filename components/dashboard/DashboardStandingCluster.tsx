import Link from "next/link";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";
import {
  STANDING_READING_ORDER,
  type StandingSectionKey,
} from "@/lib/dashboard-standing";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";

export interface DashboardStandingPresentation {
  label?: string;
  value?: ReactNode;
  detail?: ReactNode;
  href?: AppRoute;
  actionLabel?: string;
  presence?: "never" | "current" | "dormant";
}

const SECTIONS: readonly {
  key: StandingSectionKey;
  label: string;
}[] = [
  { key: "today", label: "Today" },
  { key: "body", label: "Body" },
  { key: "longer-view", label: "Longer view" },
];

export default function DashboardStandingCluster({
  placements,
  presentations,
}: {
  placements: readonly DashboardPlacement[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  return (
    <section className="mb-8" aria-labelledby="dashboard-standing-title">
      <h2
        id="dashboard-standing-title"
        className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        Standing
      </h2>
      <div
        className="overflow-hidden rounded-xl border border-black/10 bg-white dark:border-white/10 dark:bg-ink-900"
        data-testid="dashboard-standing"
      >
        {SECTIONS.map((section) => {
          const families = STANDING_READING_ORDER.flatMap((family) => {
            if (family.section !== section.key) return [];
            const members = placements.filter(
              (placement) => placement.standingFamilyKey === family.key
            );
            return members.length > 0 ? [{ family, members }] : [];
          });
          if (families.length === 0) return null;
          return (
            <section
              key={section.key}
              aria-labelledby={`dashboard-standing-${section.key}`}
              data-standing-section={section.key}
              className="border-b border-black/10 last:border-b-0 dark:border-white/10"
            >
              <h3
                id={`dashboard-standing-${section.key}`}
                className="bg-slate-50 px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:bg-ink-950/60 dark:text-slate-400"
              >
                {section.label}
              </h3>
              <dl>
                {families.map(({ family, members }) => (
                  <div
                    key={family.key}
                    className="grid gap-1 border-t border-black/5 px-4 py-3 first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 dark:border-white/5"
                    data-standing-family={family.key}
                    data-standing-composition={family.composition}
                  >
                    <dt className="text-sm font-medium text-slate-600 dark:text-slate-300">
                      {family.label}
                    </dt>
                    <dd className="min-w-0">
                      <ul
                        className={`flex min-w-0 gap-1.5 ${
                          family.composition === "members"
                            ? "flex-col"
                            : "flex-row flex-wrap gap-x-4"
                        }`}
                      >
                        {members.map((placement) => {
                          const { candidate } = placement;
                          const presentation = presentations.get(
                            candidate.candidateId
                          );
                          if (!presentation) return null;
                          const engagement =
                            candidate.relevance.kind === "profile-data"
                              ? candidate.relevance.engagement
                              : undefined;
                          const content = (
                            <>
                              {presentation.label && (
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                  {presentation.label}
                                </span>
                              )}
                              {presentation.value != null && (
                                <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                                  {presentation.value}
                                </span>
                              )}
                              {presentation.detail != null && (
                                <span className="text-xs text-slate-500 dark:text-slate-400">
                                  {presentation.detail}
                                </span>
                              )}
                              {presentation.actionLabel && (
                                <span className="text-xs font-medium text-brand-700 dark:text-brand-400">
                                  {presentation.actionLabel} →
                                </span>
                              )}
                            </>
                          );
                          const className =
                            "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm";
                          return (
                            <li
                              key={candidate.candidateId}
                              data-testid="dashboard-candidate"
                              data-candidate-id={candidate.candidateId}
                              data-fact-key={candidate.factKey}
                              data-lane="standing"
                              data-kind={candidate.kind}
                              data-engagement={engagement}
                              data-presence={presentation.presence}
                            >
                              {presentation.href ? (
                                <Link
                                  href={presentation.href}
                                  className={`${className} hover:text-brand-700 dark:hover:text-brand-400`}
                                >
                                  {content}
                                </Link>
                              ) : (
                                <div className={className}>{content}</div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </section>
  );
}
