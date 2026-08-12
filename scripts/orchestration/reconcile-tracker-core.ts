// Tracker reconciliation — the DETERMINISTIC half (#865).
//
// The tracker is spec-dense prose that quotes the code, and the code moves
// same-day. Every claim an issue body makes about main — a file path, a line
// number, a symbol, a dependency on another issue — is a fact with an expiry
// date that nobody stamps. This module re-checks those facts and emits an
// EVIDENCE LIST; it decides nothing and writes nowhere.
//
// PURE BY CONSTRUCTION. The repository arrives as a `RepoIndex` (a file list
// plus a reader) and the tracker as a `TrackerSnapshot`, both plain data, the
// same way `scripts/seed-rng.ts` takes its entropy as an argument instead of
// reading the global. Everything here is a function of those two values, so the
// whole surface is unit-testable against fixtures with no network, no git and
// no clock.
//
// ── WHAT THIS CAN AND CANNOT SEE ────────────────────────────────────────────
//
// Six drift classes were measured on this tracker on 2026-08-12. They are not
// equally reachable and pretending otherwise is how a routine becomes theatre:
//
//   REACHABLE — a citation is a fact about the FILESYSTEM, so the check is
//   mechanical: a dead path, an unqualified basename, a `file.ts:NNN` whose
//   co-located anchor symbol has moved, a dependency on an issue that closed.
//
//   NOT REACHABLE — a claim about BEHAVIOUR. "Decline the window's first tick"
//   cannot work at an hourly tick; a premise that requires a manual sleep row
//   to be a session is impossible because `upsertManualSample` writes
//   `start_time = end_time`; "not modelled at all" was modelled two months
//   earlier. Each of those needs the code to be READ. This module cannot read
//   code. What it can do is put the reader in front of the right lines: every
//   behavioural claim in this corpus sits next to a citation, so a verified
//   citation set is the agent half's reading list, and an issue whose citations
//   all check out is exactly the issue whose PROSE still has to be judged.
//
// So the honest framing: this is a triage instrument, not a verifier. It shrinks
// the corpus a human (or the skill's agent half) must read, and it publishes how
// much it could not decide.
//
// ── #2385: how this learns it should stop ───────────────────────────────────
//
// WORKING: the corpus it flags is small, specific and actionable — findings
// carry a computed correction (this path, that line) rather than a suspicion —
// and the flagged items survive review, i.e. the humans reading the report agree
// the citation really had drifted.
//
// WRONG: findings that a reviewer rejects. Two shapes, and they fail in
// opposite directions. A path or anchor "correction" that names the wrong place
// is worse than silence, because a path refresh is inside the guardrails and
// therefore the thing most likely to be applied without a second look. And an
// issue flagged for a symbol that was never supposed to exist yet — a feature
// issue naming the function it PROPOSES — is noise that trains the reader to
// skim. The second is common enough that proposals are tiered out by default
// rather than filtered by cleverness (see `symbolConfidence`).
//
// DECEPTIVE SUCCESS: **an empty report.** A healthy tracker and a script that
// has silently stopped resolving anything produce the same clean summary, and
// the clean one is the one nobody investigates. There is no way to tell them
// apart from the findings, so the report never leads with findings: it leads
// with DENOMINATORS (`ReconcileTotals`) — citations parsed, paths resolved,
// anchors testable, references followed. Zero findings out of 223 citations is
// a healthy tracker. Zero findings out of zero citations is a broken script,
// and it says so on its own front page.

/**
 * How the run was configured, derived from the environment and the command
 * line as ARGUMENTS rather than read from the globals — the same discipline
 * `scripts/seed-rng.ts` uses, and the reason the whole surface stays testable.
 */
export interface RunConfig {
  repo: string;
  /** Present ⇒ authenticated reads. Absent ⇒ the run refuses; see below. */
  token: string | null;
  /** Only sweep these issue numbers; empty ⇒ every open issue. */
  only: readonly number[];
  /** Override the watermark's lower bound (ISO 8601). */
  since: string | null;
  /** Advance the stored watermark on success. Off by default. */
  stamp: boolean;
  /** Where to write the markdown report; null ⇒ stdout. */
  out: string | null;
  /** Where to write the machine-readable evidence; null ⇒ nowhere. */
  json: string | null;
}

export const DEFAULT_REPO = "FloorLamp/allos";

export function resolveRunConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[]
): RunConfig {
  const config: RunConfig = {
    repo: env.RECONCILE_REPO || DEFAULT_REPO,
    token: env.GH_TOKEN || env.GITHUB_TOKEN || null,
    only: [],
    since: null,
    stamp: false,
    out: null,
    json: null,
  };
  const only: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => argv[++i] ?? "";
    if (arg === "--issue") only.push(...value().split(",").map(Number));
    else if (arg === "--since") config.since = value();
    else if (arg === "--out") config.out = value();
    else if (arg === "--json") config.json = value();
    else if (arg === "--stamp") config.stamp = true;
    else if (arg === "--repo") config.repo = value();
  }
  return { ...config, only: only.filter((n) => Number.isInteger(n) && n > 0) };
}

/** One open issue, reduced to the fields this module reads. */
export interface TrackerIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: readonly string[];
}

/** One merged pull request, reduced likewise. */
export interface TrackerPr {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
}

/** Everything the run knows about the tracker, as data. */
export interface TrackerSnapshot {
  /** The issues to sweep. Cross-references resolve against `issueStates`. */
  issues: readonly TrackerIssue[];
  /** Merged PRs inside the run's window (see `ReconcileWatermark`). */
  mergedPrs: readonly TrackerPr[];
  /**
   * open/closed for EVERY issue number the sweep may need to resolve, not just
   * the swept ones — a dependency almost always points at a closed issue, which
   * by definition is not in `issues`. A number absent here is UNKNOWN and is
   * reported as unverifiable rather than assumed open.
   */
  issueStates: ReadonlyMap<number, "open" | "closed">;
}

/** The repository, as data: what files exist and what is in them. */
export interface RepoIndex {
  /** Every tracked file, repo-relative, POSIX separators. */
  readonly files: readonly string[];
  /** File contents, or null when the path is not tracked. */
  read(file: string): string | null;
}

export type PathResolution =
  | { kind: "exact"; file: string }
  | { kind: "suffix"; file: string }
  | { kind: "ambiguous"; candidates: readonly string[] }
  | { kind: "missing" };

/**
 * Resolve a cited path against the repo.
 *
 * Citations are written for humans, so most are not repo-relative: bodies say
 * `RecordTable.tsx` and `family/actions.ts`, not the full path. Treating those
 * as dead is the single biggest false-positive source — a naive existence check
 * over this tracker called 46 citations dead where only 13 were. So a
 * non-exact citation is matched as a path SUFFIX first (`family/actions.ts` →
 * `app/(app)/settings/family/actions.ts`), then by basename, and only a
 * citation that matches nothing anywhere is dead.
 *
 * `ambiguous` is a real answer, not a failure: two files share the basename and
 * the citation does not say which. That is a flag for a human, never a patch.
 *
 * The basename fallback fires ONLY for a citation with no directory in it. A
 * citation that names directories and still matches nothing is making a
 * specific claim that failed — collapsing it to its basename turned
 * `app/api/integrations/apple-health/ingest/route.ts` into "ambiguous across 33
 * route.ts files", which is a worse answer than "this path does not exist".
 */
export function resolvePath(index: RepoIndex, cited: string): PathResolution {
  const norm = cited.replace(/^\.\//, "");
  if (index.files.includes(norm)) return { kind: "exact", file: norm };
  const suffix = index.files.filter((f) => f.endsWith("/" + norm));
  if (suffix.length === 1) return { kind: "suffix", file: suffix[0] };
  if (suffix.length > 1) return { kind: "ambiguous", candidates: suffix };
  if (norm.includes("/")) return { kind: "missing" };
  const byName = index.files.filter(
    (f) => f.slice(f.lastIndexOf("/") + 1) === norm
  );
  if (byName.length === 1) return { kind: "suffix", file: byName[0] };
  if (byName.length > 1) return { kind: "ambiguous", candidates: byName };
  return { kind: "missing" };
}

/**
 * A citation is ROOTED when its first segment is a real top-level directory of
 * the repository. That is what separates "this file moved or vanished" from
 * "this names something that was never a repo file at all".
 *
 * The unrooted set on this tracker is almost entirely non-claims: a SQL table
 * written like a module (`hr_minutes.ts`), a Home Assistant config
 * (`configuration.yaml`), a Next.js internal (`server/app-render/…js`), a
 * gitignored artifact. Reporting them as dead repository paths is how a
 * detector teaches its reader to skim, so they are gathered as unverifiable
 * rather than as patch candidates.
 */
export function topLevelDirs(index: RepoIndex): Set<string> {
  const out = new Set<string>();
  for (const f of index.files) {
    const slash = f.indexOf("/");
    if (slash > 0) out.add(f.slice(0, slash));
  }
  return out;
}

export function isRootedCitation(
  cited: string,
  dirs: ReadonlySet<string>
): boolean {
  const slash = cited.indexOf("/");
  return slash > 0 && dirs.has(cited.slice(0, slash));
}

/**
 * For a dead rooted path, where a file of that name now lives — if exactly one
 * does. A HINT, never a `correction`: `lib/screenings.json` →
 * `lib/datasets/data/screenings.json` is almost certainly the same file after a
 * move, but "almost certainly" is not the standard a patch is applied on, so
 * this rides in the human-readable detail and the patch stays unproposed.
 */
export function movedHint(index: RepoIndex, cited: string): string | null {
  const base = cited.slice(cited.lastIndexOf("/") + 1);
  const matches = index.files.filter(
    (f) => f.slice(f.lastIndexOf("/") + 1) === base
  );
  return matches.length === 1 ? matches[0] : null;
}

/** A `path` or `path:line` (or `path:line-line`) citation found in a body. */
export interface PathCitation {
  /** Exactly as written, without the surrounding backticks. */
  raw: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  /** Character offset of `raw` within the body — the patch anchor's neighbourhood. */
  at: number;
}

const FILE_EXTENSIONS = "ts|tsx|mjs|cjs|js|jsx|md|json|yml|yaml|sql|sh|css";

// Only INLINE CODE SPANS are parsed. A path in running prose is usually a
// gesture ("the trends page"); a path in backticks is a citation. Fenced blocks
// are excluded separately: they quote code rather than cite it, their line
// numbers are illustrative, and patching inside one would rewrite a snippet the
// author pasted deliberately.
const INLINE_CODE = /`([^`\n]+)`/g;
// The basename must START with a word character: `.d.ts` is a filename SUFFIX
// people write in prose ("a `.d.ts` file"), not a citation of any file.
const PATH_IN_SPAN = new RegExp(
  `^((?:[A-Za-z0-9_@.\\-/\\[\\]()]*/)?[A-Za-z0-9_][A-Za-z0-9_@.\\-\\[\\]()]*\\.(?:${FILE_EXTENSIONS}))(?::(\\d+)(?:[-–](\\d+))?)?$`
);

/** Character ranges covered by fenced code blocks, which parsing skips. */
export function fencedRanges(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  let open: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(body))) {
    if (open === null) open = m.index;
    else {
      out.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  // An unterminated fence swallows the rest of the body — that is what a
  // markdown renderer does too, so parsing agrees with what the reader sees.
  if (open !== null) out.push([open, body.length]);
  return out;
}

function inFence(ranges: ReadonlyArray<[number, number]>, at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}

export function parsePathCitations(body: string): PathCitation[] {
  const fences = fencedRanges(body);
  const out: PathCitation[] = [];
  for (const m of body.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    if (inFence(fences, at)) continue;
    const inner = m[1].trim();
    const hit = PATH_IN_SPAN.exec(inner);
    if (!hit) continue;
    out.push({
      raw: inner,
      path: hit[1],
      startLine: hit[2] ? Number(hit[2]) : null,
      endLine: hit[3] ? Number(hit[3]) : hit[2] ? Number(hit[2]) : null,
      at,
    });
  }
  return out;
}

/**
 * How far from a cited line an anchor may sit and still count as "the citation
 * is fine". Bodies cite the top of a function, a decorator line above it, or
 * the line after a comment header; a handful of lines of slack is the author's
 * own imprecision, not drift. Wider than this and the reader lands somewhere
 * else on screen, which is the thing that wastes the time.
 */
export const ANCHOR_TOLERANCE_LINES = 8;

/** How far either side of a citation an anchor symbol is looked for. */
export const ANCHOR_WINDOW_CHARS = 260;

const IDENTIFIER_IN_SPAN = /^[A-Za-z_][A-Za-z0-9_]{4,}$/;

/**
 * The identifiers written near a citation, nearest first.
 *
 * A bare `file.ts:600` states nothing checkable — the file has 600 lines either
 * way. What makes it checkable is that this tracker's authors never cite a line
 * without naming what is on it, in the same sentence and in backticks. That
 * co-located identifier is the ANCHOR: if it is still in the file but nowhere
 * near the cited line, the citation moved and the correction is computable.
 */
export function anchorsNear(body: string, at: number): string[] {
  const from = Math.max(0, at - ANCHOR_WINDOW_CHARS);
  const to = Math.min(body.length, at + ANCHOR_WINDOW_CHARS);
  const window = body.slice(from, to);
  const scored: Array<{ name: string; distance: number }> = [];
  for (const m of window.matchAll(INLINE_CODE)) {
    const inner = m[1].trim();
    if (!IDENTIFIER_IN_SPAN.test(inner)) continue;
    scored.push({
      name: inner,
      distance: Math.abs(from + (m.index ?? 0) - at),
    });
  }
  scored.sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();
  return scored
    .map((s) => s.name)
    .filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

/** Every 1-based line of `file` on which `symbol` appears as a whole word. */
export function locateSymbol(
  index: RepoIndex,
  file: string,
  symbol: string
): number[] {
  const source = index.read(file);
  if (source === null) return [];
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const out: number[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i + 1);
  return out;
}

export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How many lines an anchor may appear on and still PIN one.
 *
 * A token that occurs all over the file locates nothing: `profile_settings`
 * appears on sixteen lines of `lib/settings/profile-attrs.ts`, so "it is at
 * line 80" is a coin flip dressed as a correction. Above this an anchor is
 * DIFFUSE, the next candidate is tried, and if none discriminates the citation
 * is reported as untestable rather than corrected to a guess.
 */
export const MAX_ANCHOR_OCCURRENCES = 3;

export type LineVerdict =
  | { kind: "current"; anchor: string; at: readonly number[] }
  | { kind: "moved"; anchor: string; at: readonly number[]; nearest: number }
  | { kind: "no-anchor" }
  | { kind: "anchor-diffuse"; tried: readonly string[] }
  | { kind: "anchor-absent"; tried: readonly string[] };

/**
 * Is `citation`'s line number still where the thing it names lives?
 *
 * `anchor-absent` — the anchor is not in the file at all — is deliberately NOT
 * reported as drift. The symbol may have been renamed, may live in a sibling
 * file, or may be something the issue proposes rather than quotes. All three
 * need a reader, so the verdict is an admission, not an accusation.
 *
 * When an anchor is present two or three times, the correction is the NEAREST
 * occurrence, not the first: a component cited at line 1817 whose name also
 * appears in the import block at line 129 has moved to 1880, and answering 129
 * would send the reader to the top of a two-thousand-line file.
 */
export function checkLineCitation(
  index: RepoIndex,
  file: string,
  citation: PathCitation,
  body: string
): LineVerdict {
  if (citation.startLine === null) return { kind: "no-anchor" };
  const anchors = anchorsNear(body, citation.at).filter(
    (a) => a !== citation.path
  );
  if (anchors.length === 0) return { kind: "no-anchor" };
  const start = citation.startLine;
  const end = citation.endLine ?? start;
  const diffuse: string[] = [];
  const tried: string[] = [];
  for (const anchor of anchors) {
    const at = locateSymbol(index, file, anchor);
    tried.push(anchor);
    if (at.length === 0) continue;
    if (at.length > MAX_ANCHOR_OCCURRENCES) {
      diffuse.push(anchor);
      continue;
    }
    const lo = start - ANCHOR_TOLERANCE_LINES;
    const hi = end + ANCHOR_TOLERANCE_LINES;
    if (at.some((n) => n >= lo && n <= hi)) {
      return { kind: "current", anchor, at };
    }
    const nearest = [...at].sort(
      (a, b) => distanceTo(a, start, end) - distanceTo(b, start, end)
    )[0];
    return { kind: "moved", anchor, at, nearest };
  }
  if (diffuse.length > 0) return { kind: "anchor-diffuse", tried: diffuse };
  return { kind: "anchor-absent", tried };
}

function distanceTo(line: number, start: number, end: number): number {
  if (line < start) return start - line;
  if (line > end) return line - end;
  return 0;
}

/** A forward-looking reference from one issue to another. */
export interface IssueDependency {
  /** The issue depended upon. */
  target: number;
  /** The exact text matched, which is also the patch anchor. */
  phrase: string;
  /** `structured` is the `Depends-on:` convention; the rest are free text. */
  form: "structured" | "once-lands" | "after" | "blocked-by" | "requires";
  at: number;
}

const DEPENDENCY_FORMS: ReadonlyArray<{
  form: IssueDependency["form"];
  re: RegExp;
}> = [
  // The structured convention this issue introduces. Line-anchored so a
  // sentence containing the words cannot masquerade as the declaration.
  {
    form: "structured",
    re: /^[ \t]*Depends-on:[ \t]*(#\d+(?:[ \t]*,[ \t]*#\d+)*)[ \t]*$/gim,
  },
  {
    form: "once-lands",
    re: /\bonce\s+#(\d+)\s+(?:lands|ships|merges|is\s+in)\b/gi,
  },
  { form: "after", re: /\bafter\s+#(\d+)\s+(?:lands|ships|merges)\b/gi },
  { form: "blocked-by", re: /\bblocked\s+by\s+#(\d+)\b/gi },
  { form: "requires", re: /\brequires\s+#(\d+)\b/gi },
];

export function parseDependencies(body: string): IssueDependency[] {
  const fences = fencedRanges(body);
  const out: IssueDependency[] = [];
  for (const { form, re } of DEPENDENCY_FORMS) {
    for (const m of body.matchAll(re)) {
      const at = m.index ?? 0;
      if (inFence(fences, at)) continue;
      if (form === "structured") {
        for (const num of m[1].matchAll(/#(\d+)/g)) {
          out.push({ target: Number(num[1]), phrase: m[0].trim(), form, at });
        }
      } else {
        out.push({ target: Number(m[1]), phrase: m[0], form, at });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A merged PR's claim to have advanced an issue. */
export interface PrClaim {
  pr: number;
  target: number;
  /** `closes` is GitHub's own keyword set; `part-of` leaves the issue open. */
  form: "closes" | "part-of";
  phrase: string;
}

const PR_CLAIM_FORMS: ReadonlyArray<{ form: PrClaim["form"]; re: RegExp }> = [
  {
    form: "closes",
    re: /\b(?:closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve)\s+#(\d+)\b/gi,
  },
  {
    form: "part-of",
    re: /\b(?:part\s+of|towards?|progress\s+on|advances)\s+#(\d+)\b/gi,
  },
];

export function parsePrClaims(pr: TrackerPr): PrClaim[] {
  const text = `${pr.title}\n\n${pr.body}`;
  const fences = fencedRanges(text);
  const out: PrClaim[] = [];
  for (const { form, re } of PR_CLAIM_FORMS) {
    for (const m of text.matchAll(re)) {
      if (inFence(fences, m.index ?? 0)) continue;
      out.push({ pr: pr.number, target: Number(m[1]), form, phrase: m[0] });
    }
  }
  return out;
}

/** A backticked identifier an issue asserts about, with its confidence tier. */
export interface SymbolCitation {
  symbol: string;
  at: number;
}

export function parseSymbolCitations(body: string): SymbolCitation[] {
  const fences = fencedRanges(body);
  const out: SymbolCitation[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    if (inFence(fences, at)) continue;
    const inner = m[1].trim();
    if (!IDENTIFIER_IN_SPAN.test(inner)) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    out.push({ symbol: inner, at });
  }
  return out;
}

/**
 * Whether an absent symbol is EVIDENCE or NOISE, decided by what the issue is.
 *
 * A bug issue's backticked symbol is a premise: it says the code contains this,
 * and if the code does not, the premise has expired. A feature issue's
 * backticked symbol is usually the opposite claim — the name it proposes to
 * ADD. Both look identical to a scan, and on this tracker the second is the
 * majority (`lmp_date`, `location_events`, `defineAction`: all correctly
 * absent). Reporting them together buries the first, so they are tiered:
 * `premise` findings are reported, `proposal` findings are counted and left in
 * the unverifiable bucket where a reader can still ask for them.
 */
export function symbolConfidence(
  labels: readonly string[]
): "premise" | "proposal" {
  return labels.includes("bug") ? "premise" : "proposal";
}

export type FindingKind =
  | "dead-path"
  | "ambiguous-path"
  | "unqualified-path"
  | "moved-line"
  | "closed-dependency"
  | "absent-premise-symbol"
  | "open-umbrella-claim";

export type FindingBucket = "changed" | "unverifiable";

export interface ReconcileFinding {
  kind: FindingKind;
  /** Which bucket of the report this lands in — see `renderReport`. */
  bucket: FindingBucket;
  /** The issue (or, for a PR claim, the issue the PR named). */
  issue: number;
  /** Exact text in the body this finding is about; also the patch anchor. */
  anchor: string;
  /** One line, written for a human skimming a hundred of these. */
  detail: string;
  /**
   * The mechanical correction, when there is one. Present ⇒ a `path-refresh`
   * patch is proposable; absent ⇒ this needs a reader.
   */
  correction?: string;
}

/**
 * The denominators. Published FIRST in every report, because a run that finds
 * nothing is indistinguishable from a run that looked at nothing.
 */
export interface ReconcileTotals {
  issuesExamined: number;
  prsExamined: number;
  pathCitations: number;
  pathsResolved: number;
  lineCitations: number;
  lineCitationsTestable: number;
  dependenciesFollowed: number;
  symbolsChecked: number;
  /** Symbols absent from main but tiered as proposals rather than drift. */
  proposalSymbols: number;
  docsFilesExamined: number;
}

export interface ReconcileWatermark {
  /** Previous run's stamp, or null on a first run. */
  previous: string | null;
  /** This run's stamp. Both are supplied; nothing here reads a clock. */
  current: string;
}

/**
 * Step 5's half: the `docs/` contract, which is a filesystem fact and therefore
 * reachable. Two checks, both from this repo's own written rules — every
 * `docs/*-spec.md` carries an honest top-level `Status:` line, and docs stay
 * current with the code they cite.
 *
 * Whether a `shipped` status is TRUE is not decidable here and is not
 * attempted; what is decidable is whether the line exists at all and whether
 * the paths the document quotes still do.
 */
export interface DocsFinding {
  file: string;
  kind: "missing-status" | "dead-path";
  anchor: string;
  detail: string;
}

export const SPEC_STATUS_LINE = /^Status:\s*\S/m;

export function checkDocsContracts(index: RepoIndex): DocsFinding[] {
  const out: DocsFinding[] = [];
  const dirs = topLevelDirs(index);
  const docs = index.files.filter(
    (f) => f.startsWith("docs/") && f.endsWith(".md")
  );
  const seen = new Set<string>();
  for (const file of docs) {
    const source = index.read(file);
    if (source === null) continue;
    if (/-spec\.md$/.test(file) && !SPEC_STATUS_LINE.test(source)) {
      out.push({
        file,
        kind: "missing-status",
        anchor: "Status:",
        detail: "a spec document must carry an honest top-level `Status:` line",
      });
    }
    for (const citation of parsePathCitations(source)) {
      // Only a ROOTED citation is a claim about this repository — see
      // `isRootedCitation`. A doc quoting `configuration.yaml` or a Next.js
      // internal is not asserting that this checkout contains it.
      if (!isRootedCitation(citation.path, dirs)) continue;
      if (resolvePath(index, citation.path).kind !== "missing") continue;
      const key = `${file} ${citation.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file,
        kind: "dead-path",
        anchor: citation.raw,
        detail: deadPathDetail(index, citation.path),
      });
    }
  }
  return out;
}

function deadPathDetail(index: RepoIndex, cited: string): string {
  const hint = movedHint(index, cited);
  return hint
    ? `no tracked file matches \`${cited}\`; the only file of that name is \`${hint}\``
    : `no tracked file matches \`${cited}\``;
}

export interface ReconcileEvidence {
  watermark: ReconcileWatermark;
  totals: ReconcileTotals;
  findings: readonly ReconcileFinding[];
  docs: readonly DocsFinding[];
  /** Issues examined whose every checkable claim held. */
  verifiedClean: readonly number[];
}

export function gatherEvidence(
  snapshot: TrackerSnapshot,
  index: RepoIndex,
  watermark: ReconcileWatermark
): ReconcileEvidence {
  const findings: ReconcileFinding[] = [];
  const verifiedClean: number[] = [];
  const totals: ReconcileTotals = {
    issuesExamined: snapshot.issues.length,
    prsExamined: snapshot.mergedPrs.length,
    pathCitations: 0,
    pathsResolved: 0,
    lineCitations: 0,
    lineCitationsTestable: 0,
    dependenciesFollowed: 0,
    symbolsChecked: 0,
    proposalSymbols: 0,
    docsFilesExamined: 0,
  };
  const dirs = topLevelDirs(index);

  for (const issue of snapshot.issues) {
    const before = findings.length;
    const body = issue.body ?? "";

    for (const citation of parsePathCitations(body)) {
      totals.pathCitations++;
      const resolved = resolvePath(index, citation.path);
      if (resolved.kind === "missing") {
        const rooted = isRootedCitation(citation.path, dirs);
        findings.push({
          kind: "dead-path",
          bucket: rooted ? "changed" : "unverifiable",
          issue: issue.number,
          anchor: citation.raw,
          detail: rooted
            ? deadPathDetail(index, citation.path)
            : `\`${citation.path}\` is not rooted in a repo directory — it may name a table, an external file, or something proposed`,
        });
        continue;
      }
      if (resolved.kind === "ambiguous") {
        findings.push({
          kind: "ambiguous-path",
          bucket: "unverifiable",
          issue: issue.number,
          anchor: citation.raw,
          detail: `\`${citation.path}\` matches ${resolved.candidates.length} files: ${summarizeCandidates(resolved.candidates)}`,
        });
        continue;
      }
      totals.pathsResolved++;
      if (resolved.kind === "suffix") {
        findings.push({
          kind: "unqualified-path",
          bucket: "changed",
          issue: issue.number,
          anchor: citation.raw,
          detail: `\`${citation.path}\` is not repo-relative`,
          correction: resolved.file,
        });
      }
      if (citation.startLine === null) continue;
      totals.lineCitations++;
      const verdict = checkLineCitation(index, resolved.file, citation, body);
      if (verdict.kind === "current" || verdict.kind === "moved") {
        totals.lineCitationsTestable++;
      }
      if (verdict.kind === "moved") {
        findings.push({
          kind: "moved-line",
          bucket: "changed",
          issue: issue.number,
          anchor: citation.raw,
          detail: `anchor \`${verdict.anchor}\` is now at line ${verdict.at.join(", ")} of ${resolved.file}`,
          correction: `${resolved.file}:${verdict.nearest}`,
        });
      }
    }

    for (const dep of parseDependencies(body)) {
      const state = snapshot.issueStates.get(dep.target);
      if (state === undefined) continue;
      totals.dependenciesFollowed++;
      if (state === "closed") {
        findings.push({
          kind: "closed-dependency",
          bucket: "changed",
          issue: issue.number,
          anchor: dep.phrase,
          detail: `#${dep.target} is closed, but this reads as future work (${dep.form})`,
        });
      }
    }

    const tier = symbolConfidence(issue.labels);
    for (const sym of parseSymbolCitations(body)) {
      totals.symbolsChecked++;
      if (symbolExists(index, sym.symbol)) continue;
      if (tier === "proposal") {
        totals.proposalSymbols++;
        continue;
      }
      findings.push({
        kind: "absent-premise-symbol",
        bucket: "unverifiable",
        issue: issue.number,
        anchor: sym.symbol,
        detail: `\`${sym.symbol}\` appears nowhere on main; a bug premise naming it may have expired`,
      });
    }

    if (findings.length === before) verifiedClean.push(issue.number);
  }

  const open = new Set(
    snapshot.issues.filter((i) => i.state === "open").map((i) => i.number)
  );
  for (const pr of snapshot.mergedPrs) {
    for (const claim of parsePrClaims(pr)) {
      if (claim.form !== "part-of") continue;
      if (!open.has(claim.target)) continue;
      findings.push({
        kind: "open-umbrella-claim",
        bucket: "unverifiable",
        issue: claim.target,
        anchor: claim.phrase,
        detail: `merged #${pr.number} claims part of still-open #${claim.target} — verify the artifact and tick the box`,
      });
    }
  }

  const docs = checkDocsContracts(index);
  totals.docsFilesExamined = index.files.filter(
    (f) => f.startsWith("docs/") && f.endsWith(".md")
  ).length;

  return { watermark, totals, findings, docs, verifiedClean };
}

const symbolCache = new WeakMap<RepoIndex, Map<string, boolean>>();

/**
 * Does `symbol` appear anywhere on main?
 *
 * Whole-file scan rather than `git grep`, so the answer stays a function of the
 * `RepoIndex` argument and the module stays pure. Memoized per index because a
 * sweep asks the same question for every issue that names the same symbol.
 */
export function symbolExists(index: RepoIndex, symbol: string): boolean {
  let cache = symbolCache.get(index);
  if (!cache) {
    cache = new Map();
    symbolCache.set(index, cache);
  }
  const hit = cache.get(symbol);
  if (hit !== undefined) return hit;
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  let found = false;
  for (const file of index.files) {
    const source = index.read(file);
    if (source !== null && re.test(source)) {
      found = true;
      break;
    }
  }
  cache.set(symbol, found);
  return found;
}

const KIND_HEADINGS: Record<FindingKind, string> = {
  "dead-path": "Dead path references",
  "ambiguous-path": "Ambiguous path references",
  "unqualified-path": "Unqualified path references",
  "moved-line": "Line citations that moved",
  "closed-dependency": "Dependencies on closed issues",
  "absent-premise-symbol": "Bug premises naming absent symbols",
  "open-umbrella-claim": "Umbrella claims to verify and tick",
};

/**
 * The report. Denominators first, deliberately — see the module header's
 * deceptive-success note. Nothing here proposes an action on an issue's prose;
 * the `changed` bucket names patch CANDIDATES, and the skill's guardrails
 * decide which of them are inside the allowed edit vocabulary.
 */
export function renderReport(evidence: ReconcileEvidence): string {
  const t = evidence.totals;
  const lines: string[] = [];
  lines.push(`# Tracker reconciliation — ${evidence.watermark.current}`);
  lines.push("");
  lines.push(
    `Window: ${evidence.watermark.previous ?? "(first run — no watermark)"} → ${evidence.watermark.current}`
  );
  lines.push("");
  lines.push("## What was examined");
  lines.push("");
  lines.push(
    "_Read this before the findings. An empty findings list means a healthy tracker only if these numbers are non-zero._"
  );
  lines.push("");
  lines.push(`- issues examined: ${t.issuesExamined}`);
  lines.push(`- merged PRs examined: ${t.prsExamined}`);
  lines.push(
    `- path citations parsed: ${t.pathCitations} (resolved to a file: ${t.pathsResolved})`
  );
  lines.push(
    `- line citations: ${t.lineCitations} (testable against an anchor: ${t.lineCitationsTestable})`
  );
  lines.push(`- issue dependencies followed: ${t.dependenciesFollowed}`);
  lines.push(
    `- symbols checked: ${t.symbolsChecked} (absent, tiered as proposals: ${t.proposalSymbols})`
  );
  lines.push(`- docs files examined: ${t.docsFilesExamined}`);
  lines.push("");

  const changed = evidence.findings.filter((f) => f.bucket === "changed");
  const unverifiable = evidence.findings.filter(
    (f) => f.bucket === "unverifiable"
  );

  lines.push(`## Patch candidates (${changed.length})`);
  lines.push("");
  lines.push(...renderBuckets(changed));
  lines.push(`## Couldn't verify — needs a human (${unverifiable.length})`);
  lines.push("");
  lines.push(...renderBuckets(unverifiable));
  lines.push(`## Docs contract (${evidence.docs.length})`);
  lines.push("");
  if (evidence.docs.length === 0) {
    lines.push("_none_", "");
  } else {
    for (const d of evidence.docs) {
      lines.push(`- \`${d.file}\` \`${d.anchor}\` — ${d.detail}`);
    }
    lines.push("");
  }
  lines.push(`## Verified clean (${evidence.verifiedClean.length})`);
  lines.push("");
  lines.push(
    evidence.verifiedClean.length === 0
      ? "_none_"
      : evidence.verifiedClean.map((n) => `#${n}`).join(", ")
  );
  lines.push("");
  return lines.join("\n");
}

/** A candidate list is evidence, not a data dump — 95 paths is neither. */
function summarizeCandidates(candidates: readonly string[]): string {
  const shown = candidates.slice(0, 5).join(", ");
  const rest = candidates.length - 5;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

function renderBuckets(findings: readonly ReconcileFinding[]): string[] {
  if (findings.length === 0) return ["_none_", ""];
  const out: string[] = [];
  const kinds = [...new Set(findings.map((f) => f.kind))];
  for (const kind of kinds) {
    out.push(`### ${KIND_HEADINGS[kind]}`);
    out.push("");
    for (const f of findings.filter((x) => x.kind === kind)) {
      const fix = f.correction ? ` → \`${f.correction}\`` : "";
      out.push(`- #${f.issue} \`${f.anchor}\` — ${f.detail}${fix}`);
    }
    out.push("");
  }
  return out;
}
