"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
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

export default function TimelineFilterLink({
  href,
  className,
  children,
}: {
  href: AppRoute;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      onClick={() => {
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
      {children}
    </Link>
  );
}
