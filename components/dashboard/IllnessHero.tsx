"use client";

import { type ReactNode, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  IconVirus,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import type { EpisodeCollapsedStatus } from "@/lib/illness-episode-format";
import type { AppRoute } from "@/lib/hrefs";

// One patient's cockpit descriptor. `body` is the server-rendered full cockpit
// (IllnessCockpitBody) — passed as a node so the SAME component serves every cockpit and
// no data-fetch happens client-side. `status` is the collapsed at-a-glance reading;
// `displayName` is already disambiguated by the page (#531).
export interface HeroCockpit {
  profileId: number;
  profile: AvatarProfile;
  displayName: string;
  isActive: boolean;
  status: EpisodeCollapsedStatus;
  feverFree: { label: string; met: boolean } | null;
  episodeHref: AppRoute | null;
  body: ReactNode;
}

const XL_QUERY = "(min-width: 1280px)";

function subscribeToXl(onChange: () => void) {
  const query = window.matchMedia(XL_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getXlSnapshot() {
  return window.matchMedia(XL_QUERY).matches;
}

// The illness hero (issue #858): a pinned, non-hideable band above the customizable grid
// that renders every accessible open illness episode as a per-patient cockpit. The acting
// profile's own episode is a FULL cockpit at hero position; every other accessible
// profile's is a compact accordion line that expands IN PLACE into that profile's cockpit
// WITHOUT switching the acting profile. One other-profile cockpit expands at a time; the
// acting profile's cockpit collapses independently. Both remembered per viewer via
// saveState (persisted in the layout blob). COLLAPSIBLE, never hideable — a cockpit never
// disappears while its episode is open; there is no dismiss control, only collapse.
//
// Per-patient identity is a safety feature (#531/#534): the name + colored avatar ride ON
// each cockpit header and the logging controls live only inside the named, expanded
// cockpit — no positional (left/right) disambiguation, so logging Mia's dose against
// Theo can't happen from screen position alone.
export default function IllnessHero({
  cockpits,
  initialCollapsedActive,
  initialOpenOtherId,
  saveState,
}: {
  cockpits: HeroCockpit[];
  initialCollapsedActive: boolean;
  initialOpenOtherId: number | null;
  saveState: (
    collapsedActive: boolean,
    openOtherId: number | null
  ) => Promise<void>;
}) {
  const [collapsedActive, setCollapsedActive] = useState(
    initialCollapsedActive
  );
  const [openOtherId, setOpenOtherId] = useState<number | null>(
    initialOpenOtherId
  );
  const isXl = useSyncExternalStore(subscribeToXl, getXlSnapshot, () => false);

  if (cockpits.length === 0) return null;

  function toggleActive() {
    const next = !collapsedActive;
    setCollapsedActive(next);
    void saveState(next, openOtherId);
  }

  function toggleOther(profileId: number) {
    const next = openOtherId === profileId ? null : profileId;
    setOpenOtherId(next);
    void saveState(collapsedActive, next);
  }

  return (
    <section
      data-testid="illness-hero"
      aria-label="Illness"
      className="flex min-w-0 w-full flex-col gap-3"
    >
      {cockpits.map((c) => {
        // The active cockpit is one half of the XL priority row, where collapsing it
        // would leave a conspicuous empty column. Its saved compact-screen preference
        // still applies as soon as the viewport drops below XL. Household accordions
        // retain their one-open-at-a-time behavior at every size.
        const lockedOpen = c.isActive && isXl;
        const expanded = c.isActive
          ? lockedOpen || !collapsedActive
          : openOtherId === c.profileId;
        const bodyId = `illness-cockpit-body-${c.profileId}`;
        return (
          <div
            key={c.profileId}
            data-testid={`illness-cockpit-${c.profileId}`}
            data-active={c.isActive ? "true" : "false"}
            data-expanded={expanded ? "true" : "false"}
            className="card border-l-4 border-l-rose-500 dark:border-l-rose-400"
          >
            <div
              data-testid="illness-cockpit-header-row"
              className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-1"
            >
              <button
                type="button"
                data-testid={`illness-cockpit-toggle-${c.profileId}`}
                aria-expanded={expanded}
                aria-controls={bodyId}
                aria-label={
                  lockedOpen
                    ? `Illness details for ${c.displayName}`
                    : `${expanded ? "Collapse" : "Expand"} illness details for ${c.displayName}`
                }
                disabled={lockedOpen}
                onClick={() =>
                  c.isActive ? toggleActive() : toggleOther(c.profileId)
                }
                className="group flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-ink-850 dark:disabled:hover:bg-transparent"
              >
                <IconVirus
                  className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400"
                  stroke={1.75}
                  aria-hidden="true"
                />
                <Avatar profile={c.profile} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      data-testid={`illness-cockpit-name-${c.profileId}`}
                      className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
                    >
                      {c.displayName}
                    </span>
                    {!lockedOpen &&
                      (expanded ? (
                        <IconChevronDown
                          data-testid="illness-cockpit-chevron"
                          className="h-4 w-4 shrink-0 text-slate-500 transition-[color,filter] group-hover:text-brand-500 group-hover:[filter:drop-shadow(0_0_3px_currentColor)] group-focus-visible:text-brand-500 group-focus-visible:[filter:drop-shadow(0_0_3px_currentColor)] dark:text-slate-400 dark:group-hover:text-brand-400 dark:group-focus-visible:text-brand-400"
                          stroke={1.75}
                          aria-hidden="true"
                        />
                      ) : (
                        <IconChevronRight
                          data-testid="illness-cockpit-chevron"
                          className="h-4 w-4 shrink-0 text-slate-500 transition-[color,filter] group-hover:text-brand-500 group-hover:[filter:drop-shadow(0_0_3px_currentColor)] group-focus-visible:text-brand-500 group-focus-visible:[filter:drop-shadow(0_0_3px_currentColor)] dark:text-slate-400 dark:group-hover:text-brand-400 dark:group-focus-visible:text-brand-400"
                          stroke={1.75}
                          aria-hidden="true"
                        />
                      ))}
                  </span>
                  <span
                    data-testid="illness-cockpit-status-row"
                    className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
                  >
                    <span
                      data-testid={`illness-cockpit-line-${c.profileId}`}
                      className="contents"
                    >
                      <span data-testid="illness-cockpit-day">
                        {c.status.dayLabel}
                      </span>
                      {c.status.temperature ? (
                        <span className={expanded ? "hidden" : "contents"}>
                          <span aria-hidden="true">·</span>
                          <span data-testid="illness-cockpit-temperature">
                            <span
                              className={
                                c.status.temperature.high
                                  ? "font-medium text-rose-600 tabular-nums dark:text-rose-400"
                                  : "font-medium text-slate-600 tabular-nums dark:text-slate-300"
                              }
                            >
                              {c.status.temperature.value}
                            </span>
                            {c.status.temperature.when
                              ? ` ${c.status.temperature.when}`
                              : ""}
                          </span>
                        </span>
                      ) : null}
                      {c.status.lastMeds ? (
                        <span className={expanded ? "hidden" : "contents"}>
                          <span aria-hidden="true">·</span>
                          <span data-testid="illness-cockpit-last-meds">
                            Last meds {c.status.lastMeds.name}
                            {c.status.lastMeds.when
                              ? ` ${c.status.lastMeds.when}`
                              : ""}
                          </span>
                        </span>
                      ) : null}
                      {c.status.worsening ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-rose-600 dark:text-rose-400">
                            Worsening ↑
                          </span>
                        </>
                      ) : null}
                      {c.feverFree ? (
                        <span
                          data-testid="illness-cockpit-fever-status"
                          className={`badge tabular-nums ${expanded ? "hidden" : ""} ${
                            c.feverFree.met
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                              : "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
                          }`}
                        >
                          {c.feverFree.label}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </span>
              </button>
              {c.episodeHref ? (
                <Link
                  href={c.episodeHref}
                  aria-label={`More details about ${c.displayName}'s illness episode`}
                  data-testid="illness-cockpit-full-episode"
                  className="inline-flex min-h-10 shrink-0 items-center rounded-md px-2 py-1.5 text-xs font-medium text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:text-brand-400 dark:focus-visible:ring-offset-ink-900"
                >
                  More details
                </Link>
              ) : null}
            </div>
            {expanded ? <div id={bodyId}>{c.body}</div> : null}
          </div>
        );
      })}
    </section>
  );
}
