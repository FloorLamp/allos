// The Journal feed's filter vocabulary and its ONE matching predicate (issue #1634).
//
// WHY THIS MODULE EXISTS. The Journal ships one server-built window of day-groups
// and pages older ones in on demand (#451). Its filters used to run purely in the
// client over the LOADED pages, so a search for a session older than the fetched
// window reported "no matches" while the row sat in `activities` — the component
// even said so ("Only loaded activities are searched"). The fix pushes filtering
// into the store: the query layer picks the DAYS that contain a match across the
// whole ledger (lib/queries/training/activities.ts), and this module's predicate
// picks the CARDS within them. Both halves are the same question, so the predicate
// lives here — pure, imported by the server assembler AND by JournalView, which
// keeps applying it as instant refinement while a server round-trip is in flight.
//
// THE SUPERSET CONTRACT. The SQL day-selection is deliberately a SUPERSET of this
// predicate: every card this predicate accepts sits on a day the SQL returns. SQL
// may over-select a day whose only "match" is a component the card layer doesn't
// render as a part — that day then simply comes back with no matching cards and is
// dropped. What SQL must never do is under-select, because that is exactly the bug.
// Any change to the predicate below must be mirrored by a same-or-wider change to
// resolveJournalFilterSpec / the day query.

import { regionForExercise } from "./lifts";
import { activityProvenanceKey } from "./journal-format";
import type { DayGroup, JournalCardData } from "./journal-card";
import type { ActivityType } from "./types";

const ACTIVITY_TYPES: readonly ActivityType[] = [
  "strength",
  "cardio",
  "sport",
  "recovery",
];

// A muscle/region badge filter, set by clicking a badge in the detail panel.
export interface JournalTagFilter {
  kind: "muscle" | "region";
  value: string;
}

// The feed's active filter set. Plain, serializable data: it crosses the Server
// Action boundary (loadJournalPage) as-is, so every field is a primitive or a
// primitive record.
export interface JournalFilters {
  // Free text, matched against the activity title and its rendered part names.
  query: string;
  // Activity type, or null for "All".
  type: ActivityType | null;
  // Muscle/region badge, or null.
  tag: JournalTagFilter | null;
  // Only rows the editor can't re-save as-is (imports, legacy data).
  faultOnly: boolean;
  // A provenance KEY (activityProvenanceKey), or null for "Any source".
  source: string | null;
}

export const EMPTY_JOURNAL_FILTERS: JournalFilters = {
  query: "",
  type: null,
  tag: null,
  faultOnly: false,
  source: null,
};

export function journalFiltersActive(f: JournalFilters): boolean {
  return (
    f.query.trim() !== "" ||
    f.type != null ||
    f.tag != null ||
    f.faultOnly ||
    f.source != null
  );
}

// A stable identity for a filter set — the client uses it to tell whether an
// in-flight server page still describes the filters the user is looking at (a
// stale response must never overwrite a newer one).
export function journalFiltersKey(f: JournalFilters): string {
  return JSON.stringify([
    f.query.trim().toLowerCase(),
    f.type ?? "",
    f.tag ? `${f.tag.kind}:${f.tag.value}` : "",
    f.faultOnly ? 1 : 0,
    f.source ?? "",
  ]);
}

// Longest free-text query we will run as a LIKE scan. A filter box can't usefully
// carry more, and it bounds what an untrusted Server Action payload can ask the
// store to do.
const MAX_QUERY_LEN = 200;
const MAX_VALUE_LEN = 120;

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// Validate an UNTRUSTED filter payload arriving from the client. Server Actions are
// a public entry point, so the action normalizes before anything reaches SQL: an
// unknown activity type, an over-long query, or a malformed tag degrades to "no
// such filter" rather than being trusted or throwing.
export function normalizeJournalFilters(raw: unknown): JournalFilters {
  if (raw == null || typeof raw !== "object") return EMPTY_JOURNAL_FILTERS;
  const o = raw as Record<string, unknown>;
  const query =
    typeof o.query === "string" ? o.query.slice(0, MAX_QUERY_LEN) : "";
  const type = ACTIVITY_TYPES.find((t) => t === o.type) ?? null;
  let tag: JournalTagFilter | null = null;
  if (o.tag != null && typeof o.tag === "object") {
    const t = o.tag as Record<string, unknown>;
    const value = str(t.value, MAX_VALUE_LEN);
    if (value && (t.kind === "muscle" || t.kind === "region"))
      tag = { kind: t.kind, value };
  }
  return {
    query,
    type,
    tag,
    faultOnly: o.faultOnly === true,
    source: str(o.source, MAX_VALUE_LEN),
  };
}

// Does this built card match the active filters? THE definition — the server's
// filtered page and the client's instant refinement both call it, so the two can't
// disagree once a round-trip settles. Matches exactly the fields the pre-#1634
// client filter matched (title + rendered part names, type, muscle/region badge,
// fault) plus the new source filter.
export function journalCardMatches(
  card: JournalCardData,
  f: JournalFilters
): boolean {
  if (f.faultOnly && !card.fault) return false;
  if (f.type != null && card.activity.type !== f.type) return false;
  if (
    f.source != null &&
    activityProvenanceKey(card.activity.source ?? null) !== f.source
  )
    return false;
  if (f.tag) {
    const tag = f.tag;
    const hit = card.parts.some(
      (p) =>
        p.kind === "strength" &&
        (tag.kind === "muscle"
          ? p.muscle === tag.value
          : regionForExercise(p.name) === tag.value)
    );
    if (!hit) return false;
  }
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  if (card.activity.title.toLowerCase().includes(q)) return true;
  return card.parts.some((p) => p.name.toLowerCase().includes(q));
}

// Apply the predicate across a day-grouped feed, dropping days left with no cards.
// The days themselves are already the store's answer under a server-filtered page;
// this narrows each day to its matching cards (a matching day may also hold rows
// that don't match, and the merge picker needs those — see JournalView).
export function filterJournalGroups(
  groups: readonly DayGroup[],
  f: JournalFilters
): DayGroup[] {
  if (!journalFiltersActive(f)) return groups as DayGroup[];
  const out: DayGroup[] = [];
  for (const g of groups) {
    const cards = g.cards.filter((c) => journalCardMatches(c, f));
    if (cards.length > 0) out.push({ ...g, cards });
  }
  return out;
}
