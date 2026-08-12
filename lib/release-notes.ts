// In-app release notes (issue #1421) — the loader/validator over the checked-in,
// curated `lib/release-notes.json`.
//
// The notes ship WITH the image so a self-hosted operator can see what a
// `docker compose pull` brought without reaching GitHub. The file is bookkeeping
// maintained by the release process (feature PRs never touch it, so it isn't a
// merge-collision magnet), which is exactly why it needs a validator: a hand-edited
// file with a typo must fail CI loudly here, never render a half-broken page.
//
// Everything in this module is PURE (no DB, no network, no fs — the JSON is a
// bundled import), so the schema and the unread comparison are unit-testable.
//
// ONE unread computation: `hasUnseenNotes(newestNoteDate(notes), seenDate)` is the
// single verdict shared by the /whats-new page's seen-marker write and every dot
// that hints at it — the surfaces are formatters over this one answer.

import raw from "./release-notes.json";
import { clampPage, pageCount, pageOffset } from "./pagination";
import { REPO_URL } from "./version";

export const RELEASE_NOTE_KINDS = [
  "feature",
  "fix",
  "security",
  "perf",
] as const;
export type ReleaseNoteKind = (typeof RELEASE_NOTE_KINDS)[number];

export type ReleaseNoteEntry = {
  /** The merged pull request number. */
  pr: number;
  /** Short headline, product language (no internal jargon). */
  title: string;
  /** One short paragraph describing the user-visible change. */
  body: string;
  /** Optional classification; renders as a chip when present. */
  kind?: ReleaseNoteKind;
  /** Issue numbers the entry closes/addresses (may be empty). */
  issues: number[];
};

export type ReleaseNoteDay = {
  /** ISO `YYYY-MM-DD` — the day the wave shipped. */
  date: string;
  entries: ReleaseNoteEntry[];
  /** Upgrade/operator-facing notes for the day (migrations, one-time actions). */
  operatorNotes: string[];
};

export type ReleaseNotes = { days: ReleaseNoteDay[] };

/**
 * Typed failure for a malformed notes file. Thrown by `parseReleaseNotes` with a
 * `path` naming the offending field, so the schema test (and CI) points at the
 * exact edit that broke it.
 */
export class ReleaseNotesError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`release-notes${path ? ` at ${path}` : ""}: ${message}`);
    this.name = "ReleaseNotesError";
    this.path = path;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ReleaseNotesError(path, "expected a non-empty string");
  }
  return v;
}

function requirePositiveInt(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ReleaseNotesError(path, "expected a positive integer");
  }
  return v;
}

function requireArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ReleaseNotesError(path, "expected an array");
  return v;
}

function parseEntry(v: unknown, path: string): ReleaseNoteEntry {
  if (!isRecord(v)) throw new ReleaseNotesError(path, "expected an object");
  const kindRaw = v.kind;
  let kind: ReleaseNoteKind | undefined;
  if (kindRaw !== undefined) {
    if (
      typeof kindRaw !== "string" ||
      !(RELEASE_NOTE_KINDS as readonly string[]).includes(kindRaw)
    ) {
      throw new ReleaseNotesError(
        `${path}.kind`,
        `expected one of ${RELEASE_NOTE_KINDS.join(", ")}`
      );
    }
    kind = kindRaw as ReleaseNoteKind;
  }
  return {
    pr: requirePositiveInt(v.pr, `${path}.pr`),
    title: requireString(v.title, `${path}.title`),
    body: requireString(v.body, `${path}.body`),
    ...(kind ? { kind } : {}),
    issues: requireArray(v.issues, `${path}.issues`).map((n, i) =>
      requirePositiveInt(n, `${path}.issues[${i}]`)
    ),
  };
}

function parseDay(v: unknown, path: string): ReleaseNoteDay {
  if (!isRecord(v)) throw new ReleaseNotesError(path, "expected an object");
  const date = requireString(v.date, `${path}.date`);
  if (!ISO_DATE.test(date)) {
    throw new ReleaseNotesError(`${path}.date`, "expected a YYYY-MM-DD date");
  }
  const entries = requireArray(v.entries, `${path}.entries`).map((e, i) =>
    parseEntry(e, `${path}.entries[${i}]`)
  );
  if (entries.length === 0) {
    throw new ReleaseNotesError(
      `${path}.entries`,
      "expected at least one entry"
    );
  }
  return {
    date,
    entries,
    operatorNotes: requireArray(
      v.operatorNotes ?? [],
      `${path}.operatorNotes`
    ).map((n, i) => requireString(n, `${path}.operatorNotes[${i}]`)),
  };
}

/**
 * Validate an arbitrary parsed-JSON value as release notes. Throws
 * `ReleaseNotesError` on the first problem; returns a fully typed value (days
 * sorted newest-first) otherwise. Pure — the page and the tests share it.
 */
export function parseReleaseNotes(value: unknown): ReleaseNotes {
  if (!isRecord(value)) throw new ReleaseNotesError("", "expected an object");
  const days = requireArray(value.days, "days").map((d, i) =>
    parseDay(d, `days[${i}]`)
  );
  const seen = new Set<string>();
  for (const d of days) {
    if (seen.has(d.date)) {
      throw new ReleaseNotesError("days", `duplicate date ${d.date}`);
    }
    seen.add(d.date);
  }
  // Newest-first is the reading order every surface wants; sorting here means no
  // caller has to remember (and the checked-in file can stay in whatever order
  // the release process appends).
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { days };
}

let cached: ReleaseNotes | undefined;

/** The bundled, validated notes. Memoized for the process lifetime. */
export function loadReleaseNotes(): ReleaseNotes {
  if (!cached) cached = parseReleaseNotes(raw);
  return cached;
}

/** The most recent note date, or null when there are no notes at all. */
export function newestNoteDate(notes: ReleaseNotes): string | null {
  let newest: string | null = null;
  for (const d of notes.days) if (!newest || d.date > newest) newest = d.date;
  return newest;
}

/**
 * THE unread verdict (one question, one computation): notes exist and the login's
 * stored seen-marker is missing or older than the newest note date. ISO dates
 * compare lexicographically, so this is a plain string comparison. A marker from
 * the future (hand-edited, or notes rolled back) counts as seen.
 */
export function hasUnseenNotes(
  newestDate: string | null,
  seenDate: string | null | undefined
): boolean {
  if (!newestDate) return false;
  if (!seenDate) return true;
  return seenDate < newestDate;
}

/**
 * How many ENTRIES one page of /whats-new renders (#2528).
 *
 * The page's job is "what did the image I just pulled bring me" — the newest day or
 * two — and everything below that is archive. But the file is append-only by design
 * (~15 entries a merge day), so with no bound the page grew about 4,000 px a day; at
 * 20 days it was the tallest surface in the app by 1.7×, roughly 87 mobile viewport
 * heights in one scroll. Counting ENTRIES rather than days is what makes the bound
 * steady: a merge day here holds anywhere from 1 to 32 of them, so a day-count page
 * size would swing the page height by 30×.
 *
 * Not `HISTORY_PAGE_SIZE` (lib/pagination.ts): that one sizes a table row, this one
 * a titled paragraph with links, and those are different questions. The arithmetic
 * underneath is the shared one.
 */
export const WHATS_NEW_PAGE_ENTRIES = 20;

/**
 * One page of the notes, newest first, with each day kept in reading order.
 *
 * The unit is the ENTRY, so a day may be split across the boundary — and a split
 * day's `operatorNotes` ride EVERY page that shows any of its entries. Those are the
 * one-time upgrade actions for that release: a reader on page 2 looking at the rest
 * of a day must not have to page back to learn the day needs a manual step, and
 * hiding them behind a page boundary would be the regression this bound exists to
 * avoid.
 *
 * Pure, like the rest of this module — the page renders exactly what this returns.
 */
export function releaseNotesPage(
  notes: ReleaseNotes,
  page: number,
  pageSize = WHATS_NEW_PAGE_ENTRIES
): {
  days: ReleaseNoteDay[];
  page: number;
  pageCount: number;
  total: number;
  shown: number;
} {
  const size = Math.max(1, Math.trunc(pageSize));
  const total = notes.days.reduce((n, day) => n + day.entries.length, 0);
  const pages = pageCount(total, size);
  const current = Math.min(clampPage(page), pages);
  const from = pageOffset(current, size);
  const to = from + size;

  const days: ReleaseNoteDay[] = [];
  let seen = 0;
  for (const day of notes.days) {
    const start = seen;
    seen += day.entries.length;
    if (seen <= from || start >= to) continue;
    days.push({
      ...day,
      entries: day.entries.slice(
        Math.max(0, from - start),
        Math.min(day.entries.length, to - start)
      ),
    });
  }
  return {
    days,
    page: current,
    pageCount: pages,
    total,
    shown: days.reduce((n, day) => n + day.entries.length, 0),
  };
}

/** External link to a merged PR. External URLs stay plain strings (#285). */
export function pullRequestUrl(pr: number): string {
  return `${REPO_URL}/pull/${pr}`;
}

/** External link to an issue. */
export function issueUrl(issue: number): string {
  return `${REPO_URL}/issues/${issue}`;
}
