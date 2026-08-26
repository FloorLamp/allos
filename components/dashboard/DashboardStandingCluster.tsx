import Link from "next/link";
import type { ReactNode } from "react";
import { StandingDestinationLink } from "@/components/DestinationLink";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";
import type { DashboardPlacement } from "@/lib/dashboard-relevance";
import {
  STANDING_READING_ORDER,
  type StandingSectionKey,
} from "@/lib/dashboard-standing";
import type { AppRoute } from "@/lib/hrefs";
import { trackedPageFor } from "@/lib/recent-pages";
import StandingSparkline, {
  type StandingSparklineSeries,
} from "./StandingSparkline";

export interface DashboardStandingPresentation {
  label?: string;
  value?: ReactNode;
  detail?: ReactNode;
  href?: AppRoute;
  actionLabel?: string;
  presence?: "never" | "current" | "dormant";
  series?: StandingSparklineSeries;
  disclosure?: string;
}

function doorLabel(href: AppRoute): string | null {
  return trackedPageFor(href)?.label ?? null;
}

const SECTIONS: readonly { key: StandingSectionKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "body", label: "Body" },
  { key: "longer-view", label: "Longer view" },
];

export default function DashboardStandingCluster({
  placements,
  presentations,
}: {
  placements: readonly Extract<DashboardPlacement, { lane: "standing" }>[];
  presentations: ReadonlyMap<string, DashboardStandingPresentation>;
}) {
  return (
    <section
      className="section-seam-lg mb-8"
      aria-labelledby="dashboard-standing-title"
    >
      <h2
        id="dashboard-standing-title"
        className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        Standing
      </h2>
      <div
        className="overflow-hidden rounded-xl border border-(--border) bg-surface"
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
              className="border-b border-(--divider) last:border-b-0"
            >
              <h3
                id={`dashboard-standing-${section.key}`}
                className="bg-(--ghost) px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
              >
                {section.label}
              </h3>
              <div>
                {families.map(({ family, members }) => {
                  const series = members
                    .map(
                      (placement) =>
                        presentations.get(placement.candidate.candidateId)
                          ?.series
                    )
                    .find((entry) => entry != null);
                  const rows =
                    family.composition === "members"
                      ? members.map((member) => [member])
                      : [members];

                  return (
                    <div
                      key={family.key}
                      className="border-t border-(--divider) first:border-t-0"
                      role="group"
                      aria-label={family.label}
                      data-standing-family={family.key}
                      data-standing-composition={family.composition}
                      data-standing-trend={series ? "" : undefined}
                    >
                      {rows.map((rowMembers, rowIndex) => {
                        const rowSeries = rowIndex === 0 ? series : undefined;
                        const primary = rowMembers.find(
                          (placement) =>
                            presentations.get(placement.candidate.candidateId)
                              ?.href
                        );
                        const primaryPresentation = primary
                          ? presentations.get(primary.candidate.candidateId)
                          : undefined;
                        const destination = primaryPresentation?.href
                          ? doorLabel(primaryPresentation.href)
                          : null;
                        const primaryName = [
                          family.label,
                          primaryPresentation?.label,
                          destination,
                        ]
                          .filter(Boolean)
                          .join(": ");

                        return (
                          <div
                            key={rowMembers[0].candidate.candidateId}
                            className={`relative grid gap-1 px-4 first:pt-3 last:pb-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4 min-[45rem]:items-center ${
                              rowSeries
                                ? "min-[45rem]:grid-cols-[10rem_minmax(0,1fr)_11rem]"
                                : ""
                            } ${rows.length === 1 ? "py-3" : "py-1"}`}
                            data-standing-row=""
                            data-standing-trend={rowSeries ? "" : undefined}
                          >
                            {primaryPresentation?.href &&
                              (destination ? (
                                <StandingDestinationLink
                                  href={primaryPresentation.href}
                                  destinationLabel={destination}
                                >
                                  {primaryName}
                                </StandingDestinationLink>
                              ) : (
                                <Link
                                  href={primaryPresentation.href}
                                  className="absolute inset-0"
                                >
                                  <span className="sr-only">{primaryName}</span>
                                </Link>
                              ))}
                            <div className="text-sm font-medium text-slate-600 dark:text-slate-300">
                              {rowIndex === 0 ? (
                                family.label
                              ) : (
                                <span className="sr-only">{family.label}</span>
                              )}
                            </div>
                            <div className="min-w-0" data-standing-facts="">
                              <ul
                                className={`flex min-w-0 gap-1.5 ${
                                  family.composition === "members"
                                    ? "flex-col"
                                    : "flex-row flex-wrap gap-x-4"
                                }`}
                              >
                                {rowMembers.map((placement) => {
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
                                        <span
                                          data-testid="standing-label"
                                          className="text-xs text-slate-500 dark:text-slate-400"
                                        >
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
                                          {presentation.actionLabel}
                                        </span>
                                      )}
                                    </>
                                  );
                                  const className =
                                    "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm";
                                  const isPrimary =
                                    candidate.candidateId ===
                                    primary?.candidate.candidateId;
                                  const visible =
                                    presentation.href && !isPrimary ? (
                                      <Link
                                        href={presentation.href}
                                        className={`relative z-10 ${className} hover:text-brand-700 dark:hover:text-brand-400`}
                                      >
                                        {content}
                                      </Link>
                                    ) : (
                                      <div className={className}>{content}</div>
                                    );

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
                                      {presentation.disclosure ? (
                                        <div className="flex min-w-0 items-center">
                                          {visible}
                                          <InfoTooltipIcon
                                            label={presentation.disclosure}
                                          />
                                        </div>
                                      ) : (
                                        visible
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                            {rowSeries && (
                              <StandingSparkline series={rowSeries} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
