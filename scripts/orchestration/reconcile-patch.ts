// Tracker reconciliation — the PATCH half (#865), and the guardrails are the
// whole point of it.
//
// A reconciliation routine that edits issue bodies is one bad regex away from
// being the worst thing in the repository: owner prose is not recoverable from
// a diff nobody reads, and an issue is the only place some decisions are
// written down. So the patcher is built to REFUSE. Its default answer is no,
// its vocabulary is four kinds wide, and every kind is shape-constrained so
// that a malformed patch cannot express a prose edit even if someone asks for
// one.
//
// Four rules, each enforced structurally rather than by review:
//
//   1. ASSERTION-ANCHORED. A patch names the exact text it expects to find. Not
//      found ⇒ the body drifted under us ⇒ SKIP and FLAG. Found more than once
//      ⇒ we do not know which one was meant ⇒ SKIP and FLAG. There is no
//      fuzzy match, no nearest-neighbour, no "apply to the first occurrence".
//      A drifted anchor mangling prose is strictly worse than a routine that
//      does nothing at all, so the refusal is the feature.
//
//   2. FOUR KINDS, NOTHING ELSE. `status-marker`, `cross-ref`, `path-refresh`,
//      `symbol-refresh` — the factual-reconciliation vocabulary #865 allows.
//      Scope, decisions, wording and judgment are out of range by TYPE, not by
//      instruction.
//
//   3. THE REPLACEMENT'S SHAPE IS CHECKED, not just its content. A path-refresh
//      replacement must parse as a path; a cross-ref replacement must CONTAIN
//      the anchor verbatim (so it can only ever add, never delete); a status
//      marker replacement must come from the marker vocabulary; a symbol-refresh
//      must be a backticked identifier on BOTH sides. Getting the kind right is
//      therefore not enough to smuggle a rewrite through it.
//
//   4. A SYMBOL-REFRESH ALSO ASKS THE TREE (#3619). The other three kinds are
//      decidable from the body alone. A rename is not: "`a` is now called `b`"
//      is a claim about main, and a plan that renames one absent name to another
//      absent name is a typo the body cannot detect. So the kind takes a
//      resolver and refuses without one — fail-closed, because a symbol-refresh
//      applied with nothing to check against is exactly the patch that reads as
//      verified and is not.
//
// What this module cannot do is as important as what it can. There is no issue
// state here, no labels, no comments, no HTTP. It maps a body string to a body
// string. The run's toolchain is granted nothing that closes an issue — see
// `.claude/skills/reconcile-tracker/SKILL.md` and the capability scan in
// `lib/__tests__/reconcile-tracker.test.ts`.

/** The complete edit vocabulary. Adding a FIFTH is a product decision. */
export const PATCH_KINDS = [
  // A checkbox or roadmap glyph flipped to match shipped reality.
  "status-marker",
  // A bounded parenthetical pointing at the issue or PR that settled something.
  "cross-ref",
  // A file path or `path:line` citation refreshed to where the file now is.
  "path-refresh",
  // A backticked identifier citation refreshed to the name that replaced it.
  "symbol-refresh",
] as const;

export type PatchKind = (typeof PATCH_KINDS)[number];

export interface AnchoredPatch {
  kind: PatchKind;
  /** Exact text expected in the body. Must occur exactly once. */
  anchor: string;
  /** Exact text to put in its place. */
  replacement: string;
  /** Why, for the report. Not written into the issue. */
  reason: string;
}

/**
 * What the tree says about an identifier. A `symbol-refresh` is the only kind
 * whose correctness is not decidable from the issue body, so it is handed this
 * rather than reaching for the filesystem itself — the module stays a pure
 * body-to-body map and the caller stays the one holding the checkout.
 *
 * `scripts/orchestration/reconcile-apply.ts` builds it from the same
 * `RepoIndex` + `symbolExists` pair the SCAN half uses, so the two halves
 * cannot answer "does this name exist on main" differently.
 */
export type SymbolResolver = (symbol: string) => boolean;

export interface PatchOptions {
  resolveSymbol?: SymbolResolver;
}

export type PatchOutcome =
  | { ok: true; body: string }
  | { ok: false; refusal: PatchRefusal; detail: string };

export type PatchRefusal =
  | "anchor-missing"
  | "anchor-ambiguous"
  | "empty-anchor"
  | "no-change"
  | "unknown-kind"
  | "shape-rejected"
  | "symbol-unresolvable";

/**
 * The status markers a `status-marker` patch may write. Both directions are
 * listed: reconciliation flips a claim to match reality, and reality sometimes
 * moves backwards (a revert, a reopened issue).
 */
export const STATUS_MARKERS = [
  "- [ ]",
  "- [x]",
  "✅",
  "⏳",
  "🚧",
  "shipped",
  "to build",
  "partial",
] as const;

/**
 * A cross-ref may only APPEND a parenthetical of this shape. Deliberately
 * narrow: `(shipped in #123)`, `(see #123)`, `(superseded by #123)`. Anything
 * that wants to say more than that is prose and belongs to a human.
 */
const CROSS_REF_SUFFIX =
  /^ \((?:shipped in|see|superseded by|closed by|now) #\d+\)$/;

const PATH_REFRESH_SHAPE =
  /^[A-Za-z0-9_@.\-/[\]()]+\.(?:ts|tsx|mjs|cjs|js|jsx|md|json|yml|yaml|sql|sh|css)(?::\d+(?:-\d+)?)?$/;

/**
 * A `symbol-refresh` anchor and replacement are BACKTICKED identifiers, and the
 * backticks are the guardrail rather than punctuation.
 *
 * The blast radius of a symbol is wider than a path's: an identifier turns up in
 * prose that is ABOUT the rename ("we renamed it during review"), and in a
 * ruling, where a silent rewrite would make a stale decision read as validated.
 * Requiring the delimiters means the patch can only ever land inside an inline
 * code span — a CITATION — and a bare mention in a sentence is untouchable by
 * construction. It also does most of the anchor-ambiguity work for free: a body
 * that cites the same symbol twice refuses under rule 1 rather than guessing.
 *
 * The identifier itself is deliberately narrow — a JS identifier, or a dotted /
 * `#`-qualified member path. Anything with a space, a paren or a slash in it is
 * a phrase or a path, and belongs to a different kind or to a human.
 */
const SYMBOL_REFRESH_SHAPE =
  /^`[A-Za-z_$][A-Za-z0-9_$]*(?:[.#][A-Za-z_$][A-Za-z0-9_$]*)*`$/;

/** The identifier inside a `symbol-refresh` span, without its backticks. */
function symbolOf(span: string): string {
  return span.slice(1, -1);
}

/**
 * Apply one patch, or explain why not.
 *
 * The success path is `body.split(anchor).join(replacement)` under a proven
 * single occurrence, which is the strongest statement available about what
 * changed: every character outside the anchor span is byte-identical, so no
 * amount of malformed input can reach the surrounding prose.
 */
export function applyAnchoredPatch(
  body: string,
  patch: AnchoredPatch,
  options: PatchOptions = {}
): PatchOutcome {
  if (!(PATCH_KINDS as readonly string[]).includes(patch.kind)) {
    return {
      ok: false,
      refusal: "unknown-kind",
      detail: `patch kind "${patch.kind}" is not one of ${PATCH_KINDS.join(", ")}`,
    };
  }
  if (patch.anchor.length === 0) {
    return {
      ok: false,
      refusal: "empty-anchor",
      detail: "an empty anchor matches everywhere and anchors nothing",
    };
  }
  const occurrences = countOccurrences(body, patch.anchor);
  if (occurrences === 0) {
    return {
      ok: false,
      refusal: "anchor-missing",
      detail: `the body no longer contains ${JSON.stringify(patch.anchor)} — it drifted since the evidence was gathered`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      refusal: "anchor-ambiguous",
      detail: `${JSON.stringify(patch.anchor)} occurs ${occurrences} times; the patch does not say which`,
    };
  }
  if (patch.replacement === patch.anchor) {
    return {
      ok: false,
      refusal: "no-change",
      detail: "replacement is identical to the anchor",
    };
  }
  const shape = checkShape(patch);
  if (shape !== null) {
    return { ok: false, refusal: "shape-rejected", detail: shape };
  }
  const unresolvable = checkAgainstTree(patch, options);
  if (unresolvable !== null) {
    return { ok: false, refusal: "symbol-unresolvable", detail: unresolvable };
  }
  return { ok: true, body: body.replace(patch.anchor, patch.replacement) };
}

/** null ⇒ the replacement's shape is allowed for this kind. */
function checkShape(patch: AnchoredPatch): string | null {
  switch (patch.kind) {
    case "status-marker": {
      const allowed = STATUS_MARKERS as readonly string[];
      if (!allowed.includes(patch.anchor.trim())) {
        return `a status-marker anchor must be one of ${allowed.join(" / ")}, got ${JSON.stringify(patch.anchor)}`;
      }
      if (!allowed.includes(patch.replacement.trim())) {
        return `a status-marker replacement must be one of ${allowed.join(" / ")}, got ${JSON.stringify(patch.replacement)}`;
      }
      return null;
    }
    case "cross-ref": {
      if (!patch.replacement.startsWith(patch.anchor)) {
        return "a cross-ref may only APPEND to its anchor; this replacement rewrites it";
      }
      const suffix = patch.replacement.slice(patch.anchor.length);
      if (!CROSS_REF_SUFFIX.test(suffix)) {
        return `a cross-ref may only append " (see #N)" and its siblings, got ${JSON.stringify(suffix)}`;
      }
      return null;
    }
    case "path-refresh": {
      if (!PATH_REFRESH_SHAPE.test(patch.anchor)) {
        return `a path-refresh anchor must be a path citation, got ${JSON.stringify(patch.anchor)}`;
      }
      if (!PATH_REFRESH_SHAPE.test(patch.replacement)) {
        return `a path-refresh replacement must be a path citation, got ${JSON.stringify(patch.replacement)}`;
      }
      return null;
    }
    case "symbol-refresh": {
      if (!SYMBOL_REFRESH_SHAPE.test(patch.anchor)) {
        return `a symbol-refresh anchor must be a backticked identifier, got ${JSON.stringify(patch.anchor)}`;
      }
      if (!SYMBOL_REFRESH_SHAPE.test(patch.replacement)) {
        return `a symbol-refresh replacement must be a backticked identifier, got ${JSON.stringify(patch.replacement)}`;
      }
      return null;
    }
  }
}

/**
 * null ⇒ the tree agrees with the rename this patch describes.
 *
 * BOTH DIRECTIONS ARE CHECKED, and the second one is the one that catches a
 * typo. A `symbol-refresh` asserts two facts about main: the old name is gone
 * (that is what made it drift) and the new name is there (that is what makes it
 * a repair). Checking only the second would let a scan re-run rewrite a citation
 * that never expired; checking only the first is #3619's own example — a rename
 * to a name that also does not exist, applied and reported as a success.
 */
function checkAgainstTree(
  patch: AnchoredPatch,
  options: PatchOptions
): string | null {
  if (patch.kind !== "symbol-refresh") return null;
  const resolve = options.resolveSymbol;
  if (!resolve) {
    return (
      "a symbol-refresh asserts a rename against main and no resolver was " +
      "supplied; there is nothing to check it against"
    );
  }
  const from = symbolOf(patch.anchor);
  const to = symbolOf(patch.replacement);
  if (!resolve(to)) {
    return `\`${to}\` does not resolve anywhere on main either — this renames one absent name to another`;
  }
  if (resolve(from)) {
    return `\`${from}\` still exists on main, so the citation has not expired and there is nothing to refresh`;
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

export interface PatchPlanEntry {
  patch: AnchoredPatch;
  outcome: PatchOutcome;
}

/**
 * Apply a batch to one body, sequentially, and report each outcome.
 *
 * Sequential and non-transactional ON PURPOSE. A later patch's anchor is
 * checked against the body the earlier ones produced, so two patches that
 * overlap cannot both land — the second one's anchor is simply gone and it
 * refuses. A refusal never aborts the batch: the point of the run is to make
 * the safe corrections and FLAG the rest, not to require all-or-nothing.
 */
export function applyPatchPlan(
  body: string,
  patches: readonly AnchoredPatch[],
  options: PatchOptions = {}
): { body: string; entries: PatchPlanEntry[] } {
  let current = body;
  const entries: PatchPlanEntry[] = [];
  for (const patch of patches) {
    const outcome = applyAnchoredPatch(current, patch, options);
    if (outcome.ok) current = outcome.body;
    entries.push({ patch, outcome });
  }
  return { body: current, entries };
}
