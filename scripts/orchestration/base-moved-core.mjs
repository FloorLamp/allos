// HAS ANYTHING CHECKED THE TREE THAT WILL LAND? (#5235)
//
// #5129 made `kind` required on `TimezoneSwitch`. #5138's CI went green against
// a base that predated it. No textual conflict, both merged clean, and `main`
// was red on `check`, `seed` and `build` for two merges until #5148 cleared it.
// Each tree typechecks clean ON ITS OWN BASE; only the merged tree is invalid,
// which is why no per-branch check of any kind could have seen it —
// lib/__tests__/type-verdict.test.ts pins that as the combined-tree case.
//
// CI checks `head` merged with `main` as main stood at the head's CI base. When
// main has moved since, the tree that will land is one nothing has checked, and
// the only evidence that somebody checked it is a receipt from whoever did.
//
// ── THE LIMIT THIS TAKES ON, and it is a PATH rule ──────────────────────────
//
// "A merge that touched lib/ or a type/contract" is the ruling's trigger, and
// half of it is not decidable from paths: whether a diff moves a type is a
// question for the checker. That is landing-independence.mjs's documented blind
// spot (#5138) and no better path list closes it. So this does not try to
// decide it. It asks the decidable question — COULD this merge have moved a
// type — and a path can answer that: a file the TypeScript program compiles,
// anything under lib/, or the dependency and compiler contracts. Docs,
// markdown, workflows and plain .mjs tooling cannot change a type verdict, and
// are the only merges that pass without a receipt.
//
// The refusal SAYS this, because a reader has to know what the gate did not
// check: it never opens a file, so a contract carried somewhere other than a
// TypeScript type — a JSON schema, a stored SQL shape, a generated manifest —
// is outside it unless the merge also touched a path above.

/** A path a merge could move a type or a compile contract through. */
const TYPE_BEARING = [
  /^lib\//,
  /\.(?:ts|tsx|mts|cts)$/,
  /^package(?:-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
];

export const typeBearing = (paths) =>
  (paths ?? []).filter((p) => TYPE_BEARING.some((re) => re.test(p))).sort();

// ── THE ESCAPE, AND WHY IT IS TOKENS RATHER THAN PROSE ──────────────────────
//
// The receipt states that the MERGED tree was checked and NAMES THE COMMANDS.
// Reading a claim out of a body is the hazard #5254 is about, so nothing here
// interprets a sentence: the receipt is read for four literals — the head SHA,
// the base SHA it merged, `npm run typecheck`, and a test script's own name.
// It carries the merge-gate marker grammar, so a QUOTED receipt does not count,
// for the reason a quoted pass verdict does not (#5183).
//
//   MERGED-TREE-CHECKED: <head> onto <main> — npm run typecheck; npm run test:db
//
// AND THE GATE DOES NOT JUDGE WHETHER THE COMMANDS WERE ENOUGH. It checks that
// they were named and which two commits they were run against; whether the
// tiers named cover the diff is the writer's claim, and the refusal says so.
export const RECEIPT_MARKER = "MERGED-TREE-CHECKED";

const NAMES_TYPECHECK = /npm run typecheck/;
const NAMES_A_TEST_TIER = /npm (?:run )?test/;

const shortSha = (sha) => String(sha ?? "").slice(0, 8);
const states = (text, sha) =>
  [...String(text ?? "").matchAll(/[0-9a-f]{8,40}/g)].some((m) =>
    String(sha ?? "").startsWith(m[0])
  );

const howToPost = (head, baseTip) =>
  `post "${RECEIPT_MARKER}: ${shortSha(head)} onto ${shortSha(baseTip)} — ` +
  'npm run typecheck; npm run test:db" on the PR, with the commands you ' +
  "actually ran";

/**
 * @param {object} input
 * @param {string} input.head the PR head SHA
 * @param {string} input.baseRef the branch this PR merges into
 * @param {string|null} input.baseTip that branch's current tip
 * @param {string|null} input.ciBase merge base of head and baseRef — the CI base
 * @param {{sha: string, subject: string}[]} input.landed what baseRef gained since
 * @param {string[]} input.landedFiles the paths those commits touched
 * @param {boolean} input.truncated the comparison did not fit one page
 * @param {{line: string, rest: string, who: string, at: string}[]} input.marks
 *   receipt markers, newest first, already stripped of quoted ones
 * @param {string} input.unread what to say about marker lines that quoted
 * @returns {{ok: boolean, kind: string, message: string}}
 */
export function baseMovedVerdict({
  head,
  baseRef = "main",
  baseTip,
  ciBase,
  landed = [],
  landedFiles = [],
  truncated = false,
  marks = [],
  unread = "",
}) {
  // A gate that cannot tell must refuse: a base-moved check that fails open
  // licenses the merge it was written to question.
  if (truncated || !ciBase || !baseTip)
    return {
      ok: false,
      kind: "unreadable",
      message:
        `cannot tell how far ${shortSha(head)} is behind ${baseRef} — the ` +
        (truncated
          ? "comparison did not fit one page"
          : "comparison did not answer") +
        ". Re-run the gate; if it stays unreadable, merge main into the head " +
        "and let CI re-run, which needs no comparison to be right",
    };

  if (!landed.length)
    return {
      ok: true,
      kind: "current",
      message: `CI base IS ${baseRef}@${shortSha(baseTip)} — nothing landed since${unread}`,
    };

  const moved = typeBearing(landedFiles);
  const behind = `${shortSha(head)} is ${landed.length} merge(s) behind ${baseRef}@${shortSha(baseTip)} (CI base ${shortSha(ciBase)})`;
  if (!moved.length)
    return {
      ok: true,
      kind: "inert",
      message:
        `${behind}, and none of them touched lib/ or a file the compiler ` +
        `reads: ${landed.map((c) => shortSha(c.sha)).join(", ")}${unread}`,
    };

  const why =
    `${behind}, and ${moved.length} of the paths they changed could move a ` +
    `type or a compile contract (${moved.slice(0, 4).join(", ")}` +
    `${moved.length > 4 ? `, +${moved.length - 4} more` : ""}). Each tree can ` +
    "typecheck clean on its own base and still be invalid merged (#5129/#5138), " +
    "so nothing on either head answers this";
  const limit =
    " The trigger is PATHS: whether a diff really moves a type is the " +
    "checker's question, so a contract carried outside a TypeScript file is " +
    "not covered here.";

  if (!marks.length)
    return {
      ok: false,
      kind: "missing",
      message: `${why}. Merge ${baseRef} into the head and let CI re-run, or ${howToPost(head, baseTip)}.${limit}${unread}`,
    };

  const onHead = marks.find((m) => states(m.rest, head));
  if (!onHead)
    return {
      ok: false,
      kind: "stale-head",
      message:
        `the head changed since ${marks[0].who}'s merged-tree check, which ` +
        `VOIDS it exactly as it voids a receipt — re-check and ${howToPost(head, baseTip)}. ` +
        `The void receipt was "${marks[0].line}"${unread}`,
    };
  if (!states(onHead.rest, baseTip))
    return {
      ok: false,
      kind: "stale-base",
      message:
        `${marks[0].who}'s merged-tree check names ${shortSha(head)} but not ` +
        `${baseRef}@${shortSha(baseTip)}, so it is a check of some OTHER merged ` +
        `tree — ${baseRef} has moved since. Re-check against the current tip and ` +
        `${howToPost(head, baseTip)}. The stale receipt was "${onHead.line}"${unread}`,
    };
  const named = [];
  if (!NAMES_TYPECHECK.test(onHead.rest)) named.push("npm run typecheck");
  if (!NAMES_A_TEST_TIER.test(onHead.rest))
    named.push("a test tier (npm test / npm run test:db)");
  if (named.length)
    return {
      ok: false,
      kind: "unnamed-commands",
      message:
        `a merged-tree receipt states ${shortSha(head)} onto ${shortSha(baseTip)} ` +
        `but NAMES no ${named.join(" and no ")} — the ruling asks for the ` +
        "commands because a receipt nobody can check is prose. It read " +
        `"${onHead.line}"${unread}`,
    };

  return {
    ok: true,
    kind: "receipted",
    message:
      `merged tree checked for ${shortSha(head)} onto ${baseRef}@${shortSha(baseTip)} ` +
      `— ${onHead.who}: "${onHead.line}". Whether those commands cover the ` +
      "diff is their claim; this gate checked that they were named" +
      unread,
  };
}
