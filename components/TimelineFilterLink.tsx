"use client";

import { useEffect, type MouseEventHandler, type ReactNode } from "react";
import PendingLink, { PendingOverlay } from "@/components/PendingLink";
import type { AppRoute } from "@/lib/hrefs";

declare global {
  interface Window {
    __allosTimelineScrollTargetDate?: string | null;
  }
}

const DAY_ID_PREFIX = "timeline-day-";

function dayFromSection(section: Element): string | null {
  const id = section.id;
  return id.startsWith(DAY_ID_PREFIX) ? id.slice(DAY_ID_PREFIX.length) : null;
}

function timelineDaySections(feed: HTMLElement): HTMLElement[] {
  return Array.from(
    feed.querySelectorAll<HTMLElement>(`section[id^="${DAY_ID_PREFIX}"]`)
  );
}

function currentTimelineDate(
  controls: HTMLElement,
  feed: HTMLElement
): string | null {
  const y = controls.getBoundingClientRect().bottom + 8;
  let candidate: HTMLElement | null = null;
  for (const section of timelineDaySections(feed)) {
    const rect = section.getBoundingClientRect();
    if (rect.top <= y && rect.bottom > y) return dayFromSection(section);
    if (rect.top <= y) candidate = section;
  }
  return candidate ? dayFromSection(candidate) : null;
}

function closestSectionForDate(
  feed: HTMLElement,
  targetDate: string
): HTMLElement | null {
  const sections = timelineDaySections(feed);
  if (sections.length === 0) return null;

  const exact = document.getElementById(`${DAY_ID_PREFIX}${targetDate}`);
  if (exact instanceof HTMLElement) return exact;

  const target = Date.parse(`${targetDate}T00:00:00Z`);
  if (Number.isNaN(target)) return sections[0];

  let best = sections[0];
  let bestDistance = Infinity;
  for (const section of sections) {
    const date = dayFromSection(section);
    if (!date) continue;
    const time = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(time)) continue;
    const distance = Math.abs(time - target);
    if (distance < bestDistance) {
      best = section;
      bestDistance = distance;
    }
  }
  return best;
}

export function TimelineScrollRestorer({
  controlsId,
  feedId,
  restoreKey,
}: {
  controlsId: string;
  feedId: string;
  restoreKey: string;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const targetDate = window.__allosTimelineScrollTargetDate;
    if (!targetDate) return;
    window.__allosTimelineScrollTargetDate = null;

    requestAnimationFrame(() => {
      const controls = document.getElementById(controlsId);
      const feed = document.getElementById(feedId);
      if (!controls || !feed) return;
      const target = closestSectionForDate(feed, targetDate);
      if (!target) return;
      const controlsHeight = controls.getBoundingClientRect().height;
      const top =
        window.scrollY +
        target.getBoundingClientRect().top -
        controlsHeight -
        8;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  }, [controlsId, feedId, restoreKey]);

  return null;
}

// A timeline filter chip, quick-range pill or month fold header (#2657) — every
// one of them a real navigation that re-queries the feed on the server.
//
// Since #2869 they answer the tap the same way a nav row does. A chip has no
// icon to swap, so its own label is the slot: it stays where it is at reduced
// opacity with the spinner over it (components/PendingLink.tsx). And a repeat
// tap while one is in flight is absorbed — these are chips people tap in quick
// succession while narrowing a view, which is exactly the cadence #1956
// measured turning a slow navigation into one that never lands.
//
// `aria-current`/`aria-expanded` and `scroll={false}` are unchanged, and the
// scroll-target capture below still runs on the click that navigates — but NOT
// on an absorbed repeat, so one navigation records one scroll target.
export default function TimelineFilterLink({
  href,
  className,
  children,
  testId,
  title,
  label,
  ariaCurrent,
  onClick,
  // Disclosure state for the link-driven fold headers (#2657). `aria-expanded` IS
  // supported on `role="link"` — unlike `aria-pressed`, which the #2535 scan bans
  // outright — so a month card announces open/closed to assistive technology while
  // staying a plain server-rendered link that works before hydration.
  ariaExpanded,
}: {
  href: AppRoute;
  className: string;
  children: ReactNode;
  ariaCurrent?: "page" | "true" | "location";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
  title?: string;
  /**
   * What the pending state announces. Optional because this component is also
   * passed as `DateRangeControl`'s Chip link renderer. A chip whose children ARE
   * its label names itself, and anything richer says so explicitly.
   */
  label?: string;
  ariaExpanded?: boolean;
}) {
  const announced =
    label ?? (typeof children === "string" ? children : "this view");
  return (
    <PendingLink
      href={href}
      label={announced}
      scroll={false}
      testId={testId}
      ariaCurrent={ariaCurrent}
      ariaExpanded={ariaExpanded}
      title={title}
      onClick={(event) => {
        onClick?.(event);
        if (typeof window === "undefined") return;
        const controls = document.getElementById("timeline-controls");
        const feed = document.getElementById("timeline-feed");
        if (controls && controls.getBoundingClientRect().top <= 0) {
          window.__allosTimelineScrollTargetDate = feed
            ? currentTimelineDate(controls, feed)
            : null;
        }
      }}
      className={className}
    >
      {(pending) => (
        <PendingOverlay pending={pending}>{children}</PendingOverlay>
      )}
    </PendingLink>
  );
}
