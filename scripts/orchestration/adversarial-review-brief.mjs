// Classify a PR and print an independent review brief.
// Usage: node scripts/orchestration/adversarial-review-brief.mjs <pr-number> [--check] [--force]
// --check: classification only; --force: brief for any readable PR.
// Exits: 0 mandatory, 1 ordinary, 2 unable to decide, 3 consult (human judgment).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

export const EXIT = {
  mandatory: 0,
  ordinary: 1,
  cannotAnswer: 2,
  consult: 3,
};

/** Pages of `pulls/<n>/files`. Hitting it is a refusal, never a short list. */
const FILE_PAGE_CAP = 10;

export const HIGH_STAKES = [
  {
    glob: /^lib\/migrations\//,
    why: "migration runner/versions — a bug corrupts every database at boot",
  },
  { glob: /^lib\/db\.ts$/, why: "connection + boot work" },
  {
    glob: /^lib\/auth\.ts$/,
    why: "sessions and access checks — the login/profile boundary",
  },
  { glob: /^lib\/password\.ts$/, why: "credential hashing" },
  { glob: /^middleware\.ts$/, why: "the Edge cookie gate" },
  {
    glob: /^lib\/(error-log-format|log)\.ts$/,
    why: "secret redaction — a shape it misses is a credential shown to a user, and over-redaction destroys an error they must act on",
  },
  {
    glob: /^lib\/public-paths\.ts$/,
    why: "the session-free route list — one entry too many is an open door",
  },
  {
    glob: /^lib\/backup/,
    why: "backup path — failures here are silent until the day they are everything",
  },
  {
    glob: /^lib\/restore\.ts$/,
    why: "restore path — overwrites the live database",
  },
  {
    glob: /^scripts\/(backup|restore)\.ts$/,
    why: "operator backup/restore CLIs",
  },
  {
    glob: /^lib\/integrations\/ingest-timezone-sweep\.ts$/,
    why: "unattended deletion of ingested health rows on a timezone change — a bug destroys readings the user recorded and no source will re-send",
  },
  {
    glob: /^lib\/notifications\//,
    why: "send/suppression machinery — a bug here silences a safety signal",
  },
  {
    glob: /^lib\/nudge-cadence\.ts$/,
    why: "the send/freeze decision every safety planner rides",
  },
  {
    glob: /^lib\/dri\.ts$/,
    why: "DRI/upper-limit arithmetic — a bug here makes an over-limit stack stop warning",
  },
  {
    glob: /^lib\/(drug-interactions|food-drug-interactions|supplement-safety)\.ts$/,
    why: "interaction engines — a miss drops a contraindication the app already knew",
  },
  {
    glob: /^lib\/(contrast-safety|dental-safety|weather-med-safety)\.ts$/,
    why: "situational safety checks — each one is the only thing standing between a stored fact and a harmful action",
  },
  {
    glob: /^lib\/offline\//,
    why: "offline queue/replay — writes applied later, out of their original context",
  },
  {
    glob: /^lib\/(adult-only-writes|life-stage)\.ts$/,
    why: "the life-stage safety gate and the registry of which write cores carry it — a core wrongly exempted records restricted content on a minor",
  },
  {
    glob: /^lib\/settings\/profile-attrs\.ts$/,
    why: "the age resolver every life-stage gate reads — a wrong or absent age makes a minor pass an adult-only check",
  },
];

/** Added or removed authorization calls both move a boundary. */
export const CHANGED_CALL_SIGNALS = [
  {
    signal: "authorization gate",
    verdict: "MANDATORY",
    rx: /\b(?:requireWriteAccess|requireProfileWriteAccess|requireLoginWriteAccess|requireAdmin|gateItemProfile|accessForProfile|accessibleProfiles(?:ForLogin)?|requireScope|authorizedProfileSubset|profileIdsIn)\s*\(/,
    why: "a call that decides who may write or reach a profile's rows changed position — the login/profile authorization boundary moved",
  },
  {
    signal: "cross-profile visibility",
    verdict: "CONSULT",
    rx: /\b(?:sharedSurface[A-Za-z]*|itemAffordanceVisible|subjectChipVisible|readForProfiles|managingLoginIdsForProfile|crossProfile)\b/,
    why: "what a shared surface shows about ANOTHER profile changed — an orchestrator reads the hunk, because widening and narrowing look identical from outside",
  },
];

/** Count removals across the whole diff so moving a construct is not a loss. */
export const NET_REMOVAL_SIGNALS = [
  {
    signal: "profile scoping",
    rx: /\bprofile_id\s*(?:=|!=|<>)|\bprofile_id\s+IN\b/gi,
    why: "a query lost a profile_id predicate — the filter that keeps one profile's rows out of another's read or write",
  },
  {
    signal: "write transaction",
    rx: /\bwriteTx\s*\(|\.immediate\(\)/g,
    why: "a write path lost its IMMEDIATE transaction (#468) — a read-then-write that no longer commits atomically",
  },
];
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Every changed line of a shipped, non-test file, with the hunk header it sits
 * under — so a verdict can name the file AND the hunk that earned it rather than
 * a keyword.
 *
 * @param {string | undefined} patch a unified diff
 * @returns {{ hunk: string, sign: 1 | -1, text: string }[]}
 */
function changedLines(patch) {
  const out = [];
  let hunk = "";
  for (const line of (patch ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      hunk = line.slice(0, line.indexOf("@@", 2) + 2);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    const text = line.slice(1);
    if (COMMENT_LINE.test(text)) continue;
    out.push({ hunk, sign: line.startsWith("+") ? 1 : -1, text });
  }
  return out;
}

/**
 * What the diff DOES, as evidence: one entry per signal per file, each quoting the
 * changed line and naming its hunk.
 *
 * @param {string[]} files
 * @param {Record<string, string>} [patches] filename -> unified diff
 * @returns {{ file: string, hunk: string, signal: string, verdict: string,
 *   why: string, line: string }[]}
 */
export function diffSignals(files, patches) {
  const hits = [];
  const shipped = files.filter(
    (f) => SHIPPED_CODE.test(f) && !TEST_FILE.test(f)
  );
  const net = new Map(NET_REMOVAL_SIGNALS.map((s) => [s.signal, 0]));
  const lastRemoval = new Map();
  for (const file of shipped) {
    const seen = new Set();
    for (const { hunk, sign, text } of changedLines(patches?.[file])) {
      for (const rule of CHANGED_CALL_SIGNALS) {
        if (seen.has(rule.signal) || !rule.rx.test(text)) continue;
        seen.add(rule.signal);
        hits.push({
          file,
          hunk,
          signal: rule.signal,
          verdict: rule.verdict,
          why: rule.why,
          line: `${sign > 0 ? "+" : "-"}${text.trim()}`,
        });
      }
      for (const rule of NET_REMOVAL_SIGNALS) {
        const n = (text.match(rule.rx) ?? []).length;
        if (!n) continue;
        net.set(rule.signal, net.get(rule.signal) + sign * n);
        if (sign < 0) lastRemoval.set(rule.signal, { file, hunk, text });
      }
    }
  }
  for (const rule of NET_REMOVAL_SIGNALS) {
    if (net.get(rule.signal) >= 0) continue;
    const at = lastRemoval.get(rule.signal);
    hits.push({
      file: at.file,
      hunk: at.hunk,
      signal: rule.signal,
      verdict: "MANDATORY",
      why: rule.why,
      line: `-${at.text.trim()}`,
    });
  }
  return hits;
}
const LEAVES_A_SURFACE =
  "(?:export\\w*|expos\\w*|leak\\w*|disclos\\w*|shares?|shared|sharing|render\\w*|" +
  "logs?|logged|logging|sends?|sent|sending|emails?|emailed|prints?|printed|" +
  "copy|copies|copied|surfaces?|surfaced|surfacing|redact\\w*|mask\\w*|" +
  "transmit\\w*|upload\\w*|download\\w*|screenshots?)";
// Require disclosure context; a PHI gate transcript alone is not a safety claim.
const PHI_DISCLOSURE = new RegExp(
  `\\bPHI\\b(?!-)(?=[^.!?\\n]{0,90}\\b${LEAVES_A_SURFACE}\\b)|` +
    `\\b${LEAVES_A_SURFACE}\\b[^.!?\\n]{0,90}\\bPHI\\b(?!-)`,
  "i"
);

// Add terms only for safety-relevant values or decisions. Check ordinary senses
// and false-CONSULT rates against recent PRs before broadening the vocabulary.
export const SAFETY_VOCABULARY = [
  {
    term: "minor (the person)",
    rx: /(?<![-\w])minors?(?![-\w])(?=[^.!?]{0,90}\b(?:adults?|adult-only|ages?|aged|child(?:ren)?|gates?|life[-\s]stage|profiles?)\b)|\b(?:adults?|adult-only|ages?|aged|child(?:ren)?|gates?|life[-\s]stage|profiles?)\b[^.!?]{0,90}(?<![-\w])minors?(?![-\w])/i,
    why: "a claim about what a child's profile may record or see",
  },
  {
    term: "infant / newborn",
    rx: /\b(?:infants?|newborns?|neonat\w*)\b/i,
    why: "the population the life-stage gates most need to resolve correctly",
  },
  {
    term: "life stage",
    rx: /\blife[-\s]stages?\b/i,
    why: "the safety gate itself, or the criterion deciding who carries it",
  },
  {
    term: "age gate",
    rx: /\bage[-\s](?:gates?|gated|gating|checks?|thresholds?)\b/i,
    why: "a gate that reads an age — the value and the gate are different files",
  },
  {
    term: "adult-only",
    rx: /\badult[-\s]only\b/i,
    why: "the restricted-content boundary a wrong age walks straight through",
  },
  {
    term: "credential",
    rx: /\bcredentials?\b/i,
    why: "a disclosure boundary — a shape that gets past it is on a user's screen",
  },
  { term: "secret", rx: /\bsecrets?\b/i, why: "same disclosure boundary" },
  {
    term: "redact",
    rx: /\bredact\w*/i,
    why: "the masking itself; under-masking discloses, over-masking destroys",
  },
  {
    term: "PHI",
    rx: PHI_DISCLOSURE,
    why: "protected health information leaving the surface it was recorded on",
  },
  {
    term: "contraindication",
    rx: /\bcontraindicat\w*/i,
    why: "a warning the app already had the facts to give and may now drop",
  },
  {
    term: "upper limit",
    rx: /\b(?:upper[-\s]limit|tolerable[-\s]upper)\w*/i,
    why: "the arithmetic behind a warning — never computed is as silent as never sent",
  },
  {
    term: "dose safety",
    rx: /\b(?:overdose\w*|(?:missed|double|maximum|max|toxic)[-\s]dose\w*|dose[-\s](?:reminders?|escalations?|ceilings?|limits?))\b/i,
    why: "the safety signal whose justification is not effectiveness",
  },
  {
    term: "warning",
    rx: /\bwarnings?\b/i,
    why: "something the user is told; a warning that stops firing fails silently",
  },
  {
    term: "red flag",
    rx: /\bred[-\s]flags?\b/i,
    why: "the escalation path, which must not quietly stop escalating",
  },
];
// Prose applies to runtime changes or net assertion removals. Neutral prose can
// still hide weakened safety coverage; this classifier is not a semantic proof.
const SHIPPED_CODE = /^(?:lib|app|components)\/|^middleware\.ts$/;
const TEST_FILE = /(?:^|\/)__(?:tests|db_tests|action_tests)__\/|\.test\.tsx?$/;

export function shipsRuntimeCode(files) {
  return files.some((f) => SHIPPED_CODE.test(f) && !TEST_FILE.test(f));
}
/**
 * @param {string[]} files
 * @param {Record<string, string>} [patches] filename -> unified diff, when the
 *   caller has it. Absent means filename-only scope.
 * @returns {string[]}
 */
export function weakenedTests(files, patches) {
  return files.filter(
    (f) => TEST_FILE.test(f) && netExpectDelta(patches?.[f]) < 0
  );
}

/** Assertions a unified-diff hunk adds, minus the ones it removes. */
function netExpectDelta(patch) {
  let delta = 0;
  for (const line of (patch ?? "").split("\n")) {
    const n = (line.match(/expect\(/g) ?? []).length;
    if (line.startsWith("+") && !line.startsWith("+++")) delta += n;
    else if (line.startsWith("-") && !line.startsWith("---")) delta -= n;
  }
  return delta;
}
// Exclude transcripts, template checklists, and generated attribution from claims.
export function claimProse(markdown) {
  const kept = [];
  let fenced = false;
  let gateDepth = 0;
  for (const raw of (markdown ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s*(#{1,6})\s/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (/^\s*#{1,6}\s*(?:the\s+)?gates?\b/i.test(line)) {
        gateDepth = depth;
        continue;
      }
      if (gateDepth && depth <= gateDepth) gateDepth = 0;
    }
    if (gateDepth) continue;
    if (/^\s*[-*+]\s*\[[ xX]\]/.test(line)) continue;
    if (/^\s*=+\s*GATE\b/i.test(line)) continue;
    if (/^\s*_Generated by \[Claude Code\]/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

const MAX_QUOTE = 300;
export function sentenceAround(text, index, matchLength) {
  const lines = text.split("\n");
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  let li = 0;
  while (li + 1 < starts.length && starts[li + 1] <= index) li++;
  const blank = (i) => (lines[i] ?? "").trim() === "";
  // Wrapped list items stay together; headings, quotes, and table rows bound claims.
  const item = (i) => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(lines[i] ?? "");
  const edge = (i) => /^\s*(?:#{1,6}\s|>|\|)/.test(lines[i] ?? "");
  let first = li;
  while (first > 0 && !blank(first - 1) && !edge(first - 1) && !item(first)) {
    first--;
  }
  let last = li;
  while (
    last + 1 < lines.length &&
    !blank(last + 1) &&
    !edge(last + 1) &&
    !item(last + 1)
  ) {
    last++;
  }
  // Newline replacement preserves offsets.
  const from = starts[first];
  const block = text
    .slice(from, starts[last] + lines[last].length)
    .replace(/\n/g, " ");
  const rel = index - from;
  let start = 0;
  for (const m of block.slice(0, rel).matchAll(/[.!?]\s+/g)) {
    start = m.index + m[0].length;
  }
  let end = block.length;
  const after = block.slice(rel + matchLength);
  const stop = /[.!?](?:\s|$)/.exec(after);
  if (stop) end = rel + matchLength + stop.index + 1;
  let quote = block.slice(start, end).replace(/\s+/g, " ").trim();
  if (quote.length > MAX_QUOTE) {
    const hit = quote.indexOf(block.slice(rel, rel + matchLength).trim());
    const head = Math.max(0, hit - Math.floor(MAX_QUOTE / 2));
    quote =
      (head > 0 ? "… " : "") +
      quote.slice(head, head + MAX_QUOTE).trim() +
      (head + MAX_QUOTE < quote.length ? " …" : "");
  }
  return quote;
}
export function vocabularyHits(sources) {
  const hits = [];
  for (const entry of SAFETY_VOCABULARY) {
    for (const source of sources) {
      const m = entry.rx.exec(source.text ?? "");
      if (!m) continue;
      hits.push({
        term: entry.term,
        why: entry.why,
        matched: m[0],
        where: source.where,
        quote: sentenceAround(source.text, m.index, m[0].length),
      });
      break;
    }
  }
  return hits;
}

/**
 * The whole decision, over facts a caller supplies — so it can be tested without
 * a network. Returns { verdict, exit, pathHits, vocabHits, weakened, scoped }.
 *
 * @param {{ files: string[], sources: { where: string, text: string }[],
 *   patches?: Record<string, string> }} input
 */
export function classify({ files, sources, patches }) {
  const pathHits = [];
  for (const file of files) {
    const rule = HIGH_STAKES.find((r) => r.glob.test(file));
    if (rule) pathHits.push({ file, why: rule.why });
  }
  const diffHits = diffSignals(files, patches);
  const weakened = weakenedTests(files, patches);
  const scoped = shipsRuntimeCode(files) || weakened.length > 0;
  // Path and diff evidence outrank prose, which can only request consultation.
  const mandatory =
    pathHits.length > 0 || diffHits.some((h) => h.verdict === "MANDATORY");
  if (mandatory) {
    return {
      verdict: "MANDATORY",
      exit: EXIT.mandatory,
      pathHits,
      diffHits,
      vocabHits: [],
      weakened,
      scoped: true,
    };
  }
  const vocabHits = scoped ? vocabularyHits(sources) : [];
  const consult = diffHits.length > 0 || vocabHits.length > 0;
  return {
    verdict: consult ? "CONSULT" : "ordinary",
    exit: consult ? EXIT.consult : EXIT.ordinary,
    pathHits,
    diffHits,
    vocabHits,
    weakened,
    scoped,
  };
}

/** The PR's own claims, in the order a reader would weigh them. */
export function claimSources(pr, linkedIssues) {
  return [
    { where: `PR #${pr.number} title`, text: pr.title ?? "" },
    { where: `PR #${pr.number} body`, text: claimProse(pr.body) },
    ...linkedIssues.flatMap((issue) => [
      { where: `issue #${issue.number} title`, text: issue.title ?? "" },
      { where: `issue #${issue.number} body`, text: claimProse(issue.body) },
    ]),
  ];
}

/** Issue numbers this PR closes, from the keywords GitHub itself parses. */
export function closingKeywordIssues(text) {
  const found = [
    ...(text ?? "").matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
    ),
  ].map((m) => Number(m[1]));
  return [...new Set(found)];
}
function fail(what) {
  console.error(
    `adversarial-review-brief: ${what} — cannot decide, so not deciding.`
  );
  process.exit(EXIT.cannotAnswer);
}

function gh(token, pathname) {
  const run = spawnSync(
    "curl",
    [
      "-sS",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Accept: application/vnd.github+json",
      `https://api.github.com/repos/FloorLamp/allos/${pathname}`,
    ],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] }
  );
  if (run.error || run.status !== 0) {
    // Child output and errors can contain credentials; report only the exit.
    const reason = Number.isInteger(run.status)
      ? `curl exited ${run.status}`
      : "curl could not complete";
    fail(`GET ${pathname} failed (${reason})`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    fail(`GET ${pathname} returned a non-JSON body`);
  }
}

function main(argv) {
  const token = resolveReadToken();
  const prNumber = argv.find((a) => /^\d+$/.test(a));
  const checkOnly = argv.includes("--check");
  const force = argv.includes("--force");
  if (!prNumber || !token) {
    console.error(
      !prNumber
        ? "usage: adversarial-review-brief.mjs <pr-number> [--check] [--force]"
        : 'No GH_TOKEN/GITHUB_TOKEN and no authenticated gh — cannot read the PR. Re-mint via add_repo access:"push".'
    );
    process.exit(EXIT.cannotAnswer);
  }

  const pr = gh(token, `pulls/${prNumber}`);
  if (!pr || typeof pr.number !== "number") {
    fail(
      `PR #${prNumber} did not resolve (${pr?.message ?? "no number in the response"})`
    );
  }
  const files = [];
  const patches = {};
  // A full final page may hide high-stakes files: refuse unless paging exhausted.
  let swept = false;
  for (let page = 1; page <= FILE_PAGE_CAP; page++) {
    const batch = gh(
      token,
      `pulls/${prNumber}/files?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) {
      fail(
        `the file list for PR #${prNumber} came back as ${batch?.message ?? typeof batch}`
      );
    }
    for (const f of batch) {
      files.push(f.filename);
      if (f.patch) patches[f.filename] = f.patch;
    }
    if (batch.length < 100) {
      swept = true;
      break;
    }
  }
  if (!swept) {
    fail(
      `PR #${prNumber} changed more files than this reader pages ` +
        `(${FILE_PAGE_CAP} × 100), so a declared high-stakes path could sit ` +
        "behind the cap and read as `ordinary`"
    );
  }
  const linkedIssues = [];
  for (const n of closingKeywordIssues(`${pr.title}\n${pr.body ?? ""}`)) {
    const issue = gh(token, `issues/${n}`);
    if (issue && typeof issue.number === "number") linkedIssues.push(issue);
  }

  const { verdict, exit, pathHits, diffHits, vocabHits, weakened, scoped } =
    classify({
      files,
      sources: claimSources(pr, linkedIssues),
      patches,
    });
  const printDiff = (tier) => {
    for (const h of diffHits.filter((d) => d.verdict === tier)) {
      console.error(`  [${h.signal}] ${h.file} ${h.hunk} — ${h.why}`);
      console.error(`      ${h.line}`);
    }
  };

  if (verdict === "MANDATORY") {
    console.error(`MANDATORY — PR #${prNumber} (${files.length} files):`);
    for (const h of pathHits) {
      console.error(`  [declared path] ${h.file}  (${h.why})`);
    }
    printDiff("MANDATORY");
  } else if (verdict === "CONSULT") {
    console.error(
      `CONSULT — no declared path and no authorization signal in PR #${prNumber} (${files.length} files), but something here decides more than it says.`
    );
    if (weakened.length) {
      console.error(
        `  in scope because it REMOVES assertions from: ${weakened.join(", ")}`
      );
    }
    console.error(
      "An ORCHESTRATOR decides whether the lane runs. Read this evidence, not the terms:"
    );
    printDiff("CONSULT");
    for (const h of vocabHits) {
      console.error(`  [${h.term}] ${h.where} — ${h.why}`);
      console.error(`      "${h.quote}"`);
    }
  } else {
    console.error(
      `ordinary — no declared path, nothing in the hunks, and no safety vocabulary in PR #${prNumber} (${files.length} files${scoped ? "" : "; the diff ships no runtime code"}).`
    );
  }
  if (checkOnly) process.exit(exit);
  if (verdict !== "MANDATORY" && !force) process.exit(exit);

  const body =
    (pr.body ?? "").trim() ||
    "(the PR has no body — its commits' messages carry the claims)";
  const surfaceLines = [
    ...pathHits.map((h) => `- ${h.file} — ${h.why}`),
    ...diffHits.map((h) => `- ${h.file} ${h.hunk}  ${h.line}\n  (${h.why})`),
    ...vocabHits.map((h) => `- ${h.term} (${h.where}) — ${h.why}`),
  ];
  const surface = surfaceLines.length
    ? surfaceLines.join("\n")
    : "- (dispatched by --force; the surface is the orchestrator's judgement)";

  console.log(`Review FloorLamp/allos PR #${prNumber} ("${pr.title}") independently.
Try to falsify its claims with concrete evidence. Follow AGENTS.md and
docs/change-policy.md; your deliverable is a concise report.

Review surfaces and evidence:
${surface}

PR claims (context to verify):
---
${body}
---

WORKSPACE
- Use a fresh worktree at the PR merge ref, even if dispatch supplied another path:
  git fetch origin pull/${prNumber}/merge && git worktree add $SCRATCH/wt-refute-${prNumber} FETCH_HEAD
  Record the reviewed head and merge SHAs. Do not mutate the author's tree, push,
  open a PR, or merge. Scratch experiments stay in your isolated worktree.
- Before each mutation, copy the current file to a pass-unique backup under
  $SCRATCH and restore that copy afterward. Do not use git stash or checkout
  to restore experiments; the stash is shared and HEAD may not match the starting file.
- Stop only PIDs you captured yourself. No pattern kills or waiters that outlive
  the report; sibling lanes share this host.

METHOD
- For each material claim, run the input, database state, or call sequence that
  could disprove it using an existing focused test or scratch experiment.
  Reading alone is not confirmation. State unexecuted attacks and their blockers.
- When independent barriers are claimed, remove each separately and run the
  relevant coverage. Report whether the tests detect each missing barrier.
- Inspect callers that bypass the changed surface. Where relevant, exercise
  upgraded databases, concurrent writers, rollback compatibility, and orphan cleanup.
- Migrations: check reruns, parallel boot, ordering, claimed historical schemas,
  and partial failure. Distinguish a missing old table from a misspelled one.
- Auth/notifications: try direct unauthorized actions, accessible-but-wrong profile
  IDs, and suppression paths that could silence dose reminders or escalations.

REPORT
- Per material claim: CONFIRMED with what ran, or REFUTED with reproducible input
  and the relevant output. Do not claim broader coverage than the experiment provides.
- Include defects outside the claims and unexecuted attacks with blockers.
- Keep results brief; include only evidence needed to reproduce or judge a finding.
  A clean result is valid. Do not add production code or permanent tests merely
  to enlarge the review.`);
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2));
}
