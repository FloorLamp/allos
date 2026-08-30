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

/**
 * A change is ONE concise bullet (owner directive, 2026-08-13): the title is the
 * whole entry, in product language, and there is no prose body — the day card is
 * the entry, its changes are bullets. `MAX_TITLE_LENGTH` and the body refusal in
 * `parseEntry` are what keep verbosity from creeping back; detail that an
 * operator genuinely needs goes in the day's `operatorNotes`.
 *
 * TIGHTENED AND CATEGORIZED from `CATEGORIZED_SINCE` (owner, 2026-08-31): a
 * day on or after that date requires every entry to carry a `category` from
 * the closed list and to fit `CONCISE_TITLE_LENGTH`. Earlier days keep the
 * contract they were written under — shipped copy is not rewritten
 * wholesale — and render ungrouped when uncategorized.
 */
export const MAX_TITLE_LENGTH = 120;
export const CONCISE_TITLE_LENGTH = 80;
export const CATEGORIZED_SINCE = "2026-08-31";

/**
 * Where a change lives, in the words a person using the app would use — the
 * grouping header on /whats-new. Closed on purpose: a free-text category is a
 * new near-duplicate every batch. Declaration order is the tie-break when two
 * groups are equally visible (see `groupDayEntries`).
 */
export const RELEASE_NOTE_CATEGORIES = [
  "Training",
  "Nutrition",
  "Medications",
  "Medical",
  "Sleep",
  "Trends",
  "History",
  "Reminders",
  "Connected apps",
  "Household",
  "Documents",
  "Interface",
  "Security",
  "General",
] as const;
export type ReleaseNoteCategory = (typeof RELEASE_NOTE_CATEGORIES)[number];

export type ReleaseNoteEntry = {
  /** The merged pull request number. */
  pr: number;
  /** The change, as one concise bullet — product language, no internal jargon. */
  title: string;
  /** Optional classification; renders as a chip when present. */
  kind?: ReleaseNoteKind;
  /** Where the change lives. Required for days on/after CATEGORIZED_SINCE. */
  category?: ReleaseNoteCategory;
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

/** Unique identity within a day's static entry list, including repeated PRs. */
export function releaseNoteEntryKey(
  entry: ReleaseNoteEntry,
  position: number
): string {
  return `${entry.pr}:${position}`;
}

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

function parseEntry(
  v: unknown,
  path: string,
  concise: boolean
): ReleaseNoteEntry {
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
  if ("body" in v) {
    throw new ReleaseNotesError(
      `${path}.body`,
      "bodies are retired (2026-08-13): a change is one concise bullet — fold " +
        "the essential fact into the title, or the day's operatorNotes if it " +
        "is an upgrade action"
    );
  }
  const categoryRaw = v.category;
  let category: ReleaseNoteCategory | undefined;
  if (categoryRaw !== undefined) {
    if (
      typeof categoryRaw !== "string" ||
      !(RELEASE_NOTE_CATEGORIES as readonly string[]).includes(categoryRaw)
    ) {
      throw new ReleaseNotesError(
        `${path}.category`,
        `expected one of ${RELEASE_NOTE_CATEGORIES.join(", ")}`
      );
    }
    category = categoryRaw as ReleaseNoteCategory;
  } else if (concise) {
    throw new ReleaseNotesError(
      `${path}.category`,
      `days from ${CATEGORIZED_SINCE} group by category (owner, 2026-08-31) — ` +
        `pick one of ${RELEASE_NOTE_CATEGORIES.join(", ")}`
    );
  }
  const title = requireString(v.title, `${path}.title`);
  const cap = concise ? CONCISE_TITLE_LENGTH : MAX_TITLE_LENGTH;
  if (title.length > cap) {
    throw new ReleaseNotesError(
      `${path}.title`,
      `expected at most ${cap} characters (a bullet, not a paragraph) — got ${title.length}`
    );
  }
  return {
    pr: requirePositiveInt(v.pr, `${path}.pr`),
    title,
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
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
  const concise = date >= CATEGORIZED_SINCE;
  const entries = requireArray(v.entries, `${path}.entries`).map((e, i) =>
    parseEntry(e, `${path}.entries[${i}]`, concise)
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
 * two — and everything below that is archive. The file is append-only by design
 * (~15 entries a merge day), so with no bound the page grows forever; counting
 * ENTRIES rather than days is what makes the bound steady, because a merge day
 * holds anywhere from 1 to 32 of them. The number was 20 when an entry was a
 * titled paragraph; an entry is one bullet LINE now (2026-08-13), roughly a third
 * of the height, so the same steady-page-height reasoning lands at 60.
 *
 * Not `HISTORY_PAGE_SIZE` (lib/pagination.ts): that one sizes a table row, this
 * one a linked bullet, and those are different questions. The arithmetic
 * underneath is the shared one.
 */
export const WHATS_NEW_PAGE_ENTRIES = 60;

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

/** One category's slice of a day, with each entry's original position. */
export type ReleaseNoteGroup = {
  category: ReleaseNoteCategory | null;
  entries: Array<{ entry: ReleaseNoteEntry; position: number }>;
};

// SECURITY LEADS. It ranked LAST here — below `fix` — which read as the
// declaration order of RELEASE_NOTE_KINDS rather than as a decision, and it
// demoted the one bullet a person most needs to see: "Alcohol no longer
// reaches Telegram unless you turn it on for that profile" (#3846) sat first
// on 2026-08-27 and rendered fifteenth. A security note is not polish and it
// is not a capability; it is the line someone has to read before they decide
// whether their data was exposed, so it outranks both.
const KIND_RANK: Record<ReleaseNoteKind, number> = {
  security: 0,
  feature: 1,
  perf: 2,
  fix: 3,
};
const kindRank = (entry: ReleaseNoteEntry): number =>
  entry.kind ? KIND_RANK[entry.kind] : KIND_RANK.fix;

/**
 * A day's entries grouped by category, MOST VISIBLE FIRST (owner, 2026-08-31):
 * groups are ordered by the most prominent kind they contain (a new capability
 * outranks polish), then by how many new capabilities they hold, then by the
 * closed list's declaration order; inside a group, security leads, then
 * features, and file order breaks ties. Uncategorized entries
 * (pre-CATEGORIZED_SINCE days) form one null group that renders headerless
 * IN THE ORDER IT WAS WRITTEN — legacy days look exactly as they
 * always did. Pure; positions survive for stable render keys.
 */
export function groupDayEntries(day: ReleaseNoteDay): ReleaseNoteGroup[] {
  const byCategory = new Map<
    ReleaseNoteCategory | null,
    ReleaseNoteGroup["entries"]
  >();
  day.entries.forEach((entry, position) => {
    const key = entry.category ?? null;
    const list = byCategory.get(key) ?? [];
    list.push({ entry, position });
    byCategory.set(key, list);
  });
  const groups: ReleaseNoteGroup[] = [...byCategory.entries()].map(
    ([category, entries]) => ({
      category,
      // A LEGACY DAY IS NOT RE-ORDERED AT ALL. The null group is what a
      // pre-CATEGORIZED_SINCE day renders as, and this file, the page and
      // this function's own doc all promise such a day looks exactly as it
      // always did. Sorting it by kind broke that promise on 32 of 36 shipped
      // days — silently, since nothing renders the old order to compare
      // against. Curated order is the author's order; only a categorized day
      // asked to be re-arranged.
      entries:
        category === null
          ? entries.slice()
          : entries
              .slice()
              .sort(
                (a, b) =>
                  kindRank(a.entry) - kindRank(b.entry) ||
                  a.position - b.position
              ),
    })
  );
  const best = (g: ReleaseNoteGroup) =>
    Math.min(...g.entries.map((e) => kindRank(e.entry)));
  // BOUND TO THE KIND, NOT TO ITS RANK. This read `kindRank(...) === 0`, which
  // was "is a feature" only for as long as `feature` happened to be rank 0.
  // Promoting `security` to 0 silently turned this tie-break into a count of
  // SECURITY entries while every name around it — this function, the doc above,
  // the test — went on saying features. A rank is an ordering; it is not an
  // identity, and it must not be read as one.
  const features = (g: ReleaseNoteGroup) =>
    g.entries.filter((e) => e.entry.kind === "feature").length;
  const declared = (g: ReleaseNoteGroup) =>
    g.category === null
      ? RELEASE_NOTE_CATEGORIES.length
      : RELEASE_NOTE_CATEGORIES.indexOf(g.category);
  groups.sort(
    (a, b) =>
      best(a) - best(b) ||
      features(b) - features(a) ||
      declared(a) - declared(b)
  );
  return groups;
}

/** External link to a merged PR. External URLs stay plain strings (#285). */
export function pullRequestUrl(pr: number): string {
  return `${REPO_URL}/pull/${pr}`;
}

/** External link to an issue. */
export function issueUrl(issue: number): string {
  return `${REPO_URL}/issues/${issue}`;
}
