"use client";

import { type ReactNode, useState } from "react";
import {
  IconVirus,
  IconChevronDown,
  IconChevronRight,
} from "@tabler/icons-react";
import Avatar, { type AvatarProfile } from "@/components/Avatar";

// One patient's cockpit descriptor. `body` is the server-rendered full cockpit
// (IllnessCockpitBody) — passed as a node so the SAME component serves every cockpit and
// no data-fetch happens client-side. `headline`/`compactLine` are the collapsed one-liner
// (the acting profile shows the episode headline; a household member shows the accordion
// line with last-dose). `displayName` is already disambiguated by the page (#531).
export interface HeroCockpit {
  profileId: number;
  profile: AvatarProfile;
  displayName: string;
  isActive: boolean;
  headline: string;
  compactLine: string;
  body: ReactNode;
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
// each cockpit header and the controls live only inside the named, expanded cockpit — no
// positional (left/right) disambiguation, so logging Mia's dose against Theo can't happen
// from screen position alone.
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
      className="mb-6 flex flex-col gap-3"
    >
      {cockpits.map((c) => {
        const expanded = c.isActive
          ? !collapsedActive
          : openOtherId === c.profileId;
        const line = c.isActive ? c.headline : c.compactLine;
        return (
          <div
            key={c.profileId}
            data-testid={`illness-cockpit-${c.profileId}`}
            data-active={c.isActive ? "true" : "false"}
            data-expanded={expanded ? "true" : "false"}
            className="card border-l-4 border-l-rose-500 dark:border-l-rose-400"
          >
            <button
              type="button"
              data-testid={`illness-cockpit-toggle-${c.profileId}`}
              aria-expanded={expanded}
              onClick={() =>
                c.isActive ? toggleActive() : toggleOther(c.profileId)
              }
              className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg p-1 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-ink-850"
            >
              <IconVirus
                className="h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400"
                stroke={1.75}
                aria-hidden="true"
              />
              <Avatar profile={c.profile} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  data-testid={`illness-cockpit-name-${c.profileId}`}
                  className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100"
                >
                  {c.displayName}
                </span>
                <span
                  data-testid={`illness-cockpit-line-${c.profileId}`}
                  className="truncate text-xs text-slate-500 dark:text-slate-400"
                >
                  {line}
                </span>
              </span>
              {expanded ? (
                <IconChevronDown
                  className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                  stroke={1.75}
                  aria-hidden="true"
                />
              ) : (
                <IconChevronRight
                  className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                  stroke={1.75}
                  aria-hidden="true"
                />
              )}
            </button>
            {expanded && c.body}
          </div>
        );
      })}
    </section>
  );
}
