// The log sheet's "Everything else" grammar (issue #2651) — pure.
//
// The puck opens ONE sheet with two sections. The first is the due-and-usual
// context row (offers, built from reads the app already makes). The second is
// this: the whole quick-log menu, grouped into a one-line segmented domain
// selector so the long tail has large tap targets instead of a scrolling list of
// eight equal rows.
//
// ── IT ADDS NO ENTRIES AND NO WRITE PATHS ────────────────────────────────────
//
// `QUICK_LOG_ITEMS` (lib/quick-log.ts) is still the only membership list, still
// the only thing that knows which row opens which form, and still the only place
// a new loggable domain is argued in or out. This module is a VIEW over it: a
// census assigning each existing id to a segment, and the two pure functions the
// sheet needs to render that view. A new `QuickLogId` fails `tsc` here until
// someone decides where it belongs — the same declare-or-argue shape as
// QUICK_LOG_DOMAIN_CENSUS, for the same reason (#2130).
//
// ── WHY THE SEGMENTS ARE THESE FOUR ──────────────────────────────────────────
//
// They are the four things a phone is actually held up to do, and each has at
// least one entry for every profile that can see it. Empty segments are dropped
// rather than disabled: a restricted profile has no training entry at all, so it
// gets a three-segment track, not a fourth segment that refuses.

import {
  quickLogMenu,
  primaryQuickLog,
  type QuickLogId,
  type QuickLogItem,
} from "./quick-log";

export type LogSegmentId = "train" | "food" | "body" | "care";

export interface LogSegment {
  id: LogSegmentId;
  label: string;
  items: QuickLogItem[];
}

// Track order, left to right.
const SEGMENT_ORDER: readonly LogSegmentId[] = [
  "train",
  "food",
  "body",
  "care",
];

const SEGMENT_LABELS: Record<LogSegmentId, string> = {
  train: "Train",
  food: "Food",
  body: "Body",
  care: "Care",
};

/**
 * Every quick-log entry's segment. Const-asserted against the id union, so
 * retiring an id or adding one is a compile error here rather than a row that
 * silently stops rendering.
 */
export const LOG_SEGMENT_CENSUS = {
  "log-activity": "train",
  "log-food": "food",
  // The measurements form is weight + vitals + a minor's growth fields (#1486),
  // and the period offer is the other thing the body itself reports — both are
  // "something my body did", not something I took or practised.
  "log-measurements": "body",
  "log-period": "body",
  // Care is what you ADMINISTER to yourself and what you FILE about it: a dose,
  // a tracked practice, a check-in, a document. Doses lead it because they are
  // the segment's daily verb.
  "log-dose": "care",
  "log-practice": "care",
  "log-mood": "care",
  "add-document": "care",
} as const satisfies Record<QuickLogId, LogSegmentId>;

/**
 * The sheet's segments for a given profile: the SAME `quickLogMenu` the flat
 * sheet has always rendered (so both gates — the age gate and the #1042 cycle
 * relevance bit — apply exactly once, where they always did), regrouped.
 *
 * Segments with no surviving entry are dropped entirely.
 */
export function logSheetSegments(
  restricted: boolean,
  cycleRelevant = true
): LogSegment[] {
  const items = quickLogMenu(restricted, cycleRelevant);
  return SEGMENT_ORDER.map((id) => ({
    id,
    label: SEGMENT_LABELS[id],
    items: items.filter((item) => LOG_SEGMENT_CENSUS[item.id] === id),
  })).filter((segment) => segment.items.length > 0);
}

/**
 * Which segment the track opens on: the one holding the CURRENT ROUTE's promoted
 * log (`primaryQuickLog`, the same rule the top bar's contextual **+** obeys), so
 * opening the puck on Nutrition lands on Food. Falls back to the first surviving
 * segment when that item is gated away for this profile — never to an empty or
 * absent one.
 */
export function defaultLogSegment(
  segments: readonly LogSegment[],
  pathname: string,
  tab?: string | null
): LogSegmentId {
  const wanted = LOG_SEGMENT_CENSUS[primaryQuickLog(pathname, tab).id];
  return segments.some((s) => s.id === wanted)
    ? wanted
    : (segments[0]?.id ?? "care");
}
