// Per-profile "what's due" digest (issue #213, Phase 3) — PURE assembly +
// rendering, no DB/network, so both are unit-tested in lib/__tests__. The DB
// gather lives in ./upcoming-digest-data, which reuses collectUpcoming (so a
// snooze/dismiss from the Upcoming page applies to this push automatically) and
// the pure groupUpcoming banding. buildUpcomingDigest turns the banded set into a
// compact count-by-domain summary and returns null when nothing is due;
// renderUpcomingDigestMessage turns that model into the Telegram message. The
// title always names the profile — a chat may be shared by several profiles.

import type { BandGroup, UpcomingDomain } from "../upcoming";
import type { NotificationMessage } from "./types";

// Singular noun per domain; the summary pluralizes with a trailing "s". "lab"
// reads naturally as the retest signal ("1 lab, 2 labs"); "training target" and
// "vaccine" mirror the page's language.
const DOMAIN_NOUN: Record<UpcomingDomain, string> = {
  dose: "dose",
  refill: "refill",
  appointment: "appointment",
  visit: "preventive visit",
  screening: "screening",
  immunization: "vaccine",
  biomarker: "lab",
  goal: "goal",
  training: "training target",
};

// Fixed within-band ordering for the count phrase, matching the page's domain
// order so the digest reads in the same sequence the user sees.
const DOMAIN_SEQ: UpcomingDomain[] = [
  "dose",
  "refill",
  "appointment",
  "visit",
  "screening",
  "immunization",
  "biomarker",
  "goal",
  "training",
];

export interface UpcomingDigestModel {
  title: string;
  // One compact line per non-empty band, e.g. "Today: 2 doses, 1 appointment".
  lines: string[];
  // Total items across all bands (drives the title count).
  total: number;
}

function pluralize(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// "2 doses, 1 appointment" for a band: count items by domain, then render in the
// fixed domain sequence so the phrase is deterministic.
export function summarizeBand(group: BandGroup): string {
  const counts = new Map<UpcomingDomain, number>();
  for (const item of group.items) {
    counts.set(item.domain, (counts.get(item.domain) ?? 0) + 1);
  }
  return DOMAIN_SEQ.filter((d) => counts.has(d))
    .map((d) => pluralize(DOMAIN_NOUN[d], counts.get(d)!))
    .join(", ");
}

// Build the digest model from the ALREADY-BANDED set (groupUpcoming output), or
// null when there's nothing due (so the tick sends nothing rather than a hollow
// "all clear"). Empty bands are already dropped by groupUpcoming.
export function buildUpcomingDigest(
  profileName: string,
  groups: BandGroup[]
): UpcomingDigestModel | null {
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  if (nonEmpty.length === 0) return null;
  const total = nonEmpty.reduce((n, g) => n + g.items.length, 0);
  const lines = nonEmpty.map((g) => `${g.label}: ${summarizeBand(g)}`);
  const who = profileName ? ` — ${profileName}` : "";
  return {
    title: `🔔 Due soon${who}`,
    lines,
    total,
  };
}

// Render the model to a channel-agnostic NotificationMessage. One band per line;
// the title (bolded by the Telegram renderer) names the profile.
export function renderUpcomingDigestMessage(
  model: UpcomingDigestModel
): NotificationMessage {
  return { title: model.title, body: model.lines.join("\n") };
}
