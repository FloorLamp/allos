// The adversarial lane's third answer (#3030).
//
// `adversarial-review-brief.mjs --check` used to have two: 0 for "a declared
// high-stakes path matched" and 1 for everything else. 1 is the code a caller
// reads as "skip the lane", so "I checked, and this is ordinary" and "nobody has
// ever classified this file" arrived as the same word. Five PRs (#2929, #2955,
// #3004, #3018, #3028) were reported as the first when they were the second, and
// all five were caught by a worker overriding the tool by hand.
//
// What is pinned here, in the order it matters:
//
//   1. THE FIVE COME BACK CONSULT WITH THE PATH TIER OFF. Each of them matches a
//      declared path TODAY — because a glob was added after each miss, which is
//      the pattern #3030 was filed to stop. Asserting them through `classify()`
//      would therefore assert the four patches, not the new rule. So the
//      regression suite runs the text tier ALONE, which is the property the issue
//      asks for: no fifth glob needed.
//   2. THE MEASURED NARROWING. Bare `flag`, `dose`, `minor` and lowercase `phi`
//      put the false-CONSULT rate at 52% of path-ordinary PRs on the 100-PR window
//      of 2026-08-16. Each sentence in the "does not fire" block below is VERBATIM
//      from a PR in that window, named — they are the measurement, not examples
//      thought up afterwards, and they are what a widening of the vocabulary would
//      break first.
//   3. THE EXIT CODES STAY FOUR DISTINCT NUMBERS, and the error path stays 2. A
//      CONSULT collapsed back onto 1 is the original defect returning silently.
//
// The fixture is the five PRs' COMPLETE GitHub text, fetched and untrimmed
// (__fixtures__/adversarial-consult-regression-prs.json). It is ~85KB, which is
// the price of a regression suite that cannot be quietly reworded into passing:
// an excerpt chosen by the person writing the assertion proves the excerpt.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXIT,
  SAFETY_VOCABULARY,
  claimProse,
  claimSources,
  classify,
  closingKeywordIssues,
  sentenceAround,
  shipsRuntimeCode,
  vocabularyHits,
  weakenedTests,
} from "../../scripts/work/adversarial-review-brief.mjs";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/work/adversarial-review-brief.mjs");

type FixturePr = {
  number: number;
  title: string;
  body: string;
  files: string[];
  linkedIssues: { number: number; title: string; body: string }[];
};

const FIXTURE_PATH = path.join(
  REPO,
  "lib/__tests__/__fixtures__/adversarial-consult-regression-prs.json"
);
const FIXTURE_SOURCE = fs.readFileSync(FIXTURE_PATH, "utf8");

const RAW_FIXTURE: {
  _splitRuns: Record<string, string[] | string>;
  prs: FixturePr[];
} = JSON.parse(FIXTURE_SOURCE);

// #2955 is a PR ABOUT redaction, so its prose quotes credential-SHAPED literals
// as the inputs and outputs of `redactSecrets`. Pasted verbatim they red
// `gitleaks` on every push of the branch carrying them, and the scan reads
// COMMITS rather than tips, so a later commit removing them does not clear it
// (#2949, #2969) — the same reason lib/__tests__/file-sniff.test.ts does not
// paste a JWT.
//
// FRAGMENTS RATHER THAN BASE64, and this is the part worth reading: gitleaks
// 8.30 RECURSIVELY DECODES base64 (`--max-decode-depth`, default 5), so the
// obvious encoding hides nothing. Measured against the CI version rather than
// assumed — a base64 `_encodedRuns` map was written first and the scan found
// both runs through it. Split fragments are never contiguous in the file and no
// decoder rejoins them. #2955's own body states the rule this follows: "the
// credential-shaped fixtures are assembled at runtime, not written as literals."
const joinRun = (key: string): string => {
  const parts = RAW_FIXTURE._splitRuns[key];
  if (!Array.isArray(parts)) {
    throw new Error(`fixture has no split run named ${key}`);
  }
  return parts.join("");
};

const splice = (text: string): string =>
  text.replace(/\{\{ENCODED:(\w+)\}\}/g, (_whole, key: string) => joinRun(key));

const FIXTURE: { prs: FixturePr[] } = {
  prs: RAW_FIXTURE.prs.map((pr) => ({
    ...pr,
    title: splice(pr.title),
    body: splice(pr.body),
    linkedIssues: pr.linkedIssues.map((issue) => ({
      ...issue,
      title: splice(issue.title),
      body: splice(issue.body),
    })),
  })),
};

const prByNumber = (n: number): FixturePr => {
  const pr = FIXTURE.prs.find((p) => p.number === n);
  if (!pr) throw new Error(`fixture is missing PR #${n}`);
  return pr;
};

/**
 * The verdict the tool WOULD have given each of the five if no glob had ever been
 * added for it: the text tier and the scope rule, with the path tier ignored.
 */
function consultIgnoringPaths(pr: FixturePr) {
  const scoped = shipsRuntimeCode(pr.files);
  const hits = scoped
    ? vocabularyHits(claimSources(pr, pr.linkedIssues))
    : ([] as ReturnType<typeof vocabularyHits>);
  return { scoped, hits, verdict: hits.length ? "CONSULT" : "ordinary" };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------

describe("the regression suite: the five PRs the registry called ordinary", () => {
  // Written out by hand from reading each PR, not read back off the vocabulary
  // table — a key set derived from the thing under test agrees with any mutant of
  // it. Each PR's terms are the ones its author actually used about the change.
  const EXPECTED_TERMS: Record<number, string[]> = {
    // "Magnesium above the upper limit"; the warning that would stop firing.
    2929: ["upper limit", "warning"],
    // "Redact credential shapes"; `id:secret`; PHI in logs.
    2955: ["credential", "secret", "redact", "PHI"],
    // "GATED on life stage" — the exemption criterion, and nothing else.
    3004: ["life stage"],
    // "records an infant"; the life-stage gates; the age gate; adult-only.
    3018: ["infant / newborn", "life stage", "age gate", "adult-only"],
    // "a minor treated as an adult"; infant; life-stage gates; adult-only.
    3028: [
      "minor (the person)",
      "infant / newborn",
      "life stage",
      "adult-only",
    ],
  };

  it("covers exactly the five PRs #3030 names, and no others", () => {
    expect(FIXTURE.prs.map((p) => p.number).sort()).toEqual([
      2929, 2955, 3004, 3018, 3028,
    ]);
    expect(Object.keys(EXPECTED_TERMS).map(Number).sort()).toEqual([
      2929, 2955, 3004, 3018, 3028,
    ]);
  });

  for (const number of [2929, 2955, 3004, 3018, 3028]) {
    it(`#${number} comes back CONSULT from its own text, with no declared path`, () => {
      const pr = prByNumber(number);
      const { verdict, scoped, hits } = consultIgnoringPaths(pr);
      expect(scoped).toBe(true);
      expect(verdict).toBe("CONSULT");
      expect(hits.map((h) => h.term)).toEqual(EXPECTED_TERMS[number]);
    });

    it(`#${number} quotes the sentence around each term, from a real source`, () => {
      const pr = prByNumber(number);
      const { hits } = consultIgnoringPaths(pr);
      const sources = claimSources(pr, pr.linkedIssues);
      for (const hit of hits) {
        const source = sources.find((s) => s.where === hit.where);
        expect(source).toBeDefined();
        // The quote is the PR's own words, not a rendering of the term.
        expect(collapse(source!.text)).toContain(
          hit.quote.replace(/^… | …$/g, "")
        );
        expect(hit.quote.toLowerCase()).toContain(hit.matched.toLowerCase());
        // A term is 3-18 characters; a claim is a sentence. If these ever come
        // out equal, the worker has to go read the PR anyway, which is the
        // cost this tier exists to remove.
        expect(hit.quote.length).toBeGreaterThan(hit.matched.length + 20);
      }
    });
  }

  it("each of the five is a diff the scope rule lets the text tier see", () => {
    for (const pr of FIXTURE.prs) expect(shipsRuntimeCode(pr.files)).toBe(true);
  });

  // Two assertions, and they pull in opposite directions on purpose: the file on
  // disk must carry no credential SHAPE, and the text the classifier is asserted
  // against must still be what the authors wrote. Encoding that quietly dropped
  // the run would pass the first and fail the second.
  it("stores no credential-shaped run in the committed fixture", () => {
    const vendorPrefixed =
      /\b(?:sk_live_|sk_test_|rk_live_|rk_test_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xoxb-|xoxp-|xoxa-|xoxr-|xoxs-|xapp-|sk-ant-)[A-Za-z0-9_-]{8,}/;
    const authScheme =
      /\b(?:Bearer|Basic|Token|ApiKey)\s+[A-Za-z0-9._~+/=-]{12,}/i;
    const jwtShaped =
      /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/;
    for (const rule of [vendorPrefixed, authScheme, jwtShaped]) {
      expect(FIXTURE_SOURCE).not.toMatch(rule);
      // …and not through a base64 layer either, which is how gitleaks 8.30
      // reads it. Any run of base64 in the file is decoded and re-checked, so
      // the fragments cannot quietly become an encoding again.
      for (const [b64] of FIXTURE_SOURCE.matchAll(
        /[A-Za-z0-9+/]{16,}={0,2}/g
      )) {
        expect(Buffer.from(b64, "base64").toString("utf8")).not.toMatch(rule);
      }
    }
    // The scan must be looking at something: the placeholders are present.
    expect(FIXTURE_SOURCE).toContain("{{ENCODED:stripeShapedRun}}");
    expect(FIXTURE_SOURCE).toContain("{{ENCODED:basicSchemeShapedRun}}");
  });

  it("splices every encoded run back, so the prose stays the authors' own", () => {
    const spliced = FIXTURE.prs
      .flatMap((pr) => [
        pr.title,
        pr.body,
        ...pr.linkedIssues.flatMap((i) => [i.title, i.body]),
      ])
      .join("\n");
    expect(spliced).not.toContain("{{ENCODED:");
    // WHAT THE FRAGMENTS JOIN TO, asserted by SHAPE and LENGTH rather than
    // against the fragments themselves. Checking only `toContain(joinRun(k))`
    // is vacuous in the direction that matters: empty the fragments and the
    // expectation empties with them, so `toContain("sent X-Api-Key: ")` still
    // passes and the fixture has quietly lost the text the regression run reads.
    // Measured — that mutant was written and passed before these four lines.
    const stripeRun = joinRun("stripeShapedRun");
    expect(stripeRun).toHaveLength(29);
    expect(stripeRun).toMatch(/^sk_live_[A-Za-z0-9]{21}$/);
    const basicRun = joinRun("basicSchemeShapedRun");
    expect(basicRun).toHaveLength(36);
    expect(Buffer.from(basicRun, "base64").toString("utf8")).toMatch(
      /^[a-z_]+:[a-z0-9_]+$/
    );
    // …and they land in #2955's real table rows, in their surrounding prose, so
    // this cannot pass on a run spliced into the wrong place.
    expect(spliced).toContain(`sent X-Api-Key: ${stripeRun}`);
    expect(spliced).toContain(`Authorization: Basic ${basicRun}`);
    // Every declared run is actually used; a stale entry is dead weight that
    // reads as coverage.
    for (const key of Object.keys(RAW_FIXTURE._splitRuns)) {
      if (key === "_readme") continue;
      expect(FIXTURE_SOURCE).toContain(`{{ENCODED:${key}}}`);
    }
  });

  it("finds the linked issues by the keywords GitHub itself parses", () => {
    // #2929 closes three; #3004 and #3028 one each. A linked issue carries the
    // claim as often as the PR does, so losing this quietly halves the corpus.
    expect(closingKeywordIssues(prByNumber(2929).body).sort()).toEqual([
      2795, 2796, 2798,
    ]);
    expect(closingKeywordIssues(prByNumber(3028).body)).toEqual([3020]);
    expect(closingKeywordIssues("Fixes #12\nCloses #12\nresolved #34")).toEqual(
      [12, 34]
    );
    expect(closingKeywordIssues("see #99 and PR #100")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the vocabulary is narrowed against a measurement, not by taste", () => {
  it("declares exactly the terms that were measured", () => {
    // Pinned so a widening is a visible edit. The membership test a future editor
    // applies is stated above the table in the script; step 3 of it is "state the
    // new rate", and this list is what that rate was measured over.
    expect(SAFETY_VOCABULARY.map((v) => v.term)).toEqual([
      "minor (the person)",
      "infant / newborn",
      "life stage",
      "age gate",
      "adult-only",
      "credential",
      "secret",
      "redact",
      "PHI",
      "contraindication",
      "upper limit",
      "dose safety",
      "warning",
      "red flag",
    ]);
    for (const entry of SAFETY_VOCABULARY) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.rx).toBeInstanceOf(RegExp);
    }
  });

  // Every string below is VERBATIM from a merged PR in the measured window, with
  // its number. These are the sentences that made bare `flag`, `dose`, `minor`
  // and lowercase `phi` unusable: 38 of 73 path-ordinary PRs fired on them.
  const ORDINARY_SENTENCES: [string, string][] = [
    [
      "#2952",
      "#590's own slice (b) flagged this family as \"same family to consider: 'encounter for…' Z-codes that leak into problem lists\"",
    ],
    [
      "#2996",
      "The issue puts card headings and copy out of scope and IA/tone is the owner's call, so this is flagged, not changed.",
    ],
    [
      "#2982",
      "the same build-time flag wraps the Server Action fetch (`router-reducer/reducers/server-action-reducer.js`)",
    ],
    [
      "#2865",
      'The "Due & usual now" chip reads **"3 doses due"** — a count with no names.',
    ],
    ["#2865", "## 1. The dose chip doesn't say WHAT is due"],
    [
      "#2916",
      "`lipids` entry (psyllium husk, oat beta-glucan) — curated-first, no dose stated, same shared screens.",
    ],
    [
      "#2964",
      "`phi-scan` and `format` (they exist precisely for every diff), and any change to CI's own skip set.",
    ],
    [
      "#2822",
      "**#2612 and #2615 are closed** (the mechanical half — the episode-page unroll, the batched minors).",
    ],
  ];

  for (const [pr, sentence] of ORDINARY_SENTENCES) {
    it(`does not fire on ${pr}: ${sentence.slice(0, 48)}…`, () => {
      expect(
        vocabularyHits([{ where: "body", text: sentence }]).map((h) => h.term)
      ).toEqual([]);
    });
  }

  // The other direction, so the narrowing is not simply "match nothing": the
  // safety sense of each narrowed term still fires.
  const SAFETY_SENTENCES: [string, string][] = [
    ["red flag", "The red flag escalation stops firing for a stale reading."],
    ["dose safety", "A missed-dose escalation must never be suppressed here."],
    ["dose safety", "The overdose ceiling is computed from the daily total."],
    ["minor (the person)", "a minor treated as an adult unlocks the surface"],
    ["PHI", "This writes PHI to a shared surface."],
  ];

  for (const [term, sentence] of SAFETY_SENTENCES) {
    it(`still fires on the safety sense: ${sentence.slice(0, 44)}…`, () => {
      expect(
        vocabularyHits([{ where: "body", text: sentence }]).map((h) => h.term)
      ).toContain(term);
    });
  }

  it("does not read a hyphenated compound as the bare word", () => {
    // #2813's real dependabot group name, put in a sentence that would otherwise
    // co-locate. Constructed, not quoted — the point is the hyphen, and #2813's
    // own text is already rejected for want of a neighbouring age word.
    expect(
      vocabularyHits([
        {
          where: "b",
          text: "Bump @napi-rs/canvas in the npm-minor-and-patch group for every profile.",
        },
      ])
    ).toEqual([]);
  });

  it("reads PHI as an acronym, not as the phi-scan gate's name", () => {
    expect(
      vocabularyHits([{ where: "b", text: "phi-scan OK, format clean." }])
    ).toEqual([]);
    expect(
      vocabularyHits([{ where: "b", text: "PHI-scan OK, format clean." }])
    ).toEqual([]);
    expect(
      vocabularyHits([{ where: "b", text: "No PHI reaches the export." }]).map(
        (h) => h.term
      )
    ).toEqual(["PHI"]);
  });
});

// ---------------------------------------------------------------------------

describe("what counts as a claim", () => {
  it("drops the PR template's own checklist", () => {
    // Verbatim from .github/pull_request_template.md. This one line put
    // lowercase `phi` on 12 of 73 path-ordinary PRs by itself.
    const body =
      "- [ ] No PHI in code, fixtures, seed, or this description (synthetic/obfuscated only)\n";
    expect(claimProse(body).trim()).toBe("");
    expect(vocabularyHits([{ where: "b", text: claimProse(body) }])).toEqual(
      []
    );
    // …but the same words as prose ARE a claim.
    const prose = "No PHI in code is asserted by the new scan.";
    expect(claimProse(prose)).toBe(prose);
    expect(vocabularyHits([{ where: "b", text: prose }])).toHaveLength(1);
  });

  it("drops fenced blocks — pasted gate output is not an argument", () => {
    const body = [
      "The change is inert.",
      "```",
      "GATE: phi-scan — credential redaction warning",
      "```",
      "Nothing else.",
    ].join("\n");
    expect(claimProse(body)).toBe("The change is inert.\nNothing else.");
    expect(vocabularyHits([{ where: "b", text: claimProse(body) }])).toEqual(
      []
    );
  });

  it("drops an unfenced gate transcript line and the generated footer", () => {
    const body = [
      "=== GATE: lint === credential",
      "_Generated by [Claude Code](https://claude.ai/code)_",
      "Real prose about a warning.",
    ].join("\n");
    expect(claimProse(body)).toBe("Real prose about a warning.");
  });

  it("keeps prose that merely mentions a fence marker mid-line", () => {
    const body = "Use ``` to fence, and beware the credential in the log.";
    expect(claimProse(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------

describe("the scope rule: a diff that ships no runtime code decides nothing", () => {
  it("sees lib/, app/, components/ and middleware.ts", () => {
    expect(shipsRuntimeCode(["lib/fast-write.ts"])).toBe(true);
    expect(shipsRuntimeCode(["app/(app)/fasting/page.tsx"])).toBe(true);
    expect(shipsRuntimeCode(["components/AgeBadge.tsx"])).toBe(true);
    expect(shipsRuntimeCode(["middleware.ts"])).toBe(true);
  });

  it("does not see docs, scripts, e2e or CI config", () => {
    expect(
      shipsRuntimeCode([
        "docs/work/review-merge.md",
        "scripts/work/adversarial-review-brief.mjs",
        "e2e/fasting.spec.ts",
        ".github/workflows/ci.yml",
      ])
    ).toBe(false);
  });

  it("does not see a test-only diff, in any of the three test tiers", () => {
    expect(
      shipsRuntimeCode([
        "lib/__tests__/dri.test.ts",
        "lib/__db_tests__/stored-age-zero.test.ts",
        "lib/__action_tests__/onboarding.actions.test.ts",
        "components/__tests__/Badge.test.tsx",
      ])
    ).toBe(false);
  });

  it("sees a module changed alongside its own tests", () => {
    expect(shipsRuntimeCode(["lib/__tests__/dri.test.ts", "lib/dri.ts"])).toBe(
      true
    );
  });

  it("keeps a safety-worded work PR ordinary", () => {
    // #2932's real title. It is entirely about the safety tier and says so in
    // every sentence; it changes one script and two docs, and a bug in it cannot
    // disclose or decide anything at runtime.
    const verdict = classify({
      files: [
        "scripts/work/adversarial-review-brief.mjs",
        "docs/work/review-merge.md",
      ],
      sources: [
        {
          where: "title",
          text: "adversarial: the safety tier covers deciding, not just sending",
        },
        {
          where: "body",
          text: "A warning that is never computed is as silent as one that is never sent.",
        },
      ],
    });
    expect(verdict.verdict).toBe("ordinary");
    expect(verdict.exit).toBe(EXIT.ordinary);
    expect(verdict.scoped).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("sentenceAround quotes the claim, not the keyword", () => {
  it("returns the whole sentence the term sits in", () => {
    const text =
      "First sentence, unrelated. The stored age is what every life-stage gate reads. A third one follows.";
    const at = text.indexOf("life-stage");
    expect(sentenceAround(text, at, "life-stage".length)).toBe(
      "The stored age is what every life-stage gate reads."
    );
  });

  it("does not run a bullet's quote into the next bullet", () => {
    const text = [
      "- The age resolver decides whether a profile is a minor,",
      "  and the gate is a different file.",
      "- An unrelated bullet about layout.",
    ].join("\n");
    const at = text.indexOf("minor");
    const quote = sentenceAround(text, at, "minor".length);
    expect(quote).toContain("the gate is a different file");
    expect(quote).not.toContain("unrelated bullet");
  });

  it("stops at a heading rather than swallowing the section above it", () => {
    const text = "## A heading\nThe warning stops firing.";
    const at = text.indexOf("warning");
    expect(sentenceAround(text, at, "warning".length)).toBe(
      "The warning stops firing."
    );
  });

  it("windows a long unpunctuated block around the term, keeping it inside", () => {
    const filler = "padding words that go on and on ".repeat(30);
    const text = `${filler}the adult-only boundary ${filler}`;
    const at = text.indexOf("adult-only");
    const quote = sentenceAround(text, at, "adult-only".length);
    expect(quote).toContain("adult-only");
    expect(quote.length).toBeLessThanOrEqual(320);
    expect(quote.startsWith("…")).toBe(true);
    expect(quote.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the exit codes", () => {
  it("gives the four answers four different numbers", () => {
    expect(Object.keys(EXIT).sort()).toEqual([
      "cannotAnswer",
      "consult",
      "mandatory",
      "ordinary",
    ]);
    expect(EXIT).toEqual({
      mandatory: 0,
      ordinary: 1,
      cannotAnswer: 2,
      consult: 3,
    });
    expect(new Set(Object.values(EXIT)).size).toBe(4);
  });

  it("never returns the ordinary code for an unclassified safety claim", () => {
    // The whole defect, in one assertion: this diff matches no declared path.
    const verdict = classify({
      files: ["lib/medical-extract/normalize.ts"],
      sources: [
        {
          where: "title",
          text: 'normalizeAge reads the unit, so a document stating "6 months" records an infant',
        },
      ],
    });
    expect(verdict.verdict).toBe("CONSULT");
    expect(verdict.exit).toBe(EXIT.consult);
    expect(verdict.exit).not.toBe(EXIT.ordinary);
    expect(verdict.pathHits).toEqual([]);
  });

  it("still says MANDATORY on a declared path, and does not consult first", () => {
    const verdict = classify({
      files: ["lib/auth.ts"],
      sources: [{ where: "title", text: "no safety words at all here" }],
    });
    expect(verdict.verdict).toBe("MANDATORY");
    expect(verdict.exit).toBe(EXIT.mandatory);
    expect(verdict.pathHits.map((h) => h.file)).toEqual(["lib/auth.ts"]);
    expect(verdict.vocabHits).toEqual([]);
  });

  it("says ordinary when neither tier matches", () => {
    const verdict = classify({
      files: ["lib/chart-colors.ts"],
      sources: [{ where: "title", text: "Recolour the trend series" }],
    });
    expect(verdict.verdict).toBe("ordinary");
    expect(verdict.exit).toBe(EXIT.ordinary);
  });

  it("exits 2, never 1 or 3, when it cannot read the PR at all", () => {
    // A refusal of a DIFFERENT question than CONSULT: the tool has no facts.
    // PATH is emptied so the `gh auth token` fallback (host.mjs) cannot
    // answer on a machine that happens to carry an authenticated gh.
    const run = spawnSync(process.execPath, [SCRIPT, "12345", "--check"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        PATH: "/nonexistent",
      },
    });
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain(
      "No GH_TOKEN/GITHUB_TOKEN and no authenticated gh"
    );
  });

  it("exits 2 on a missing PR number rather than answering", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--check"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("usage:");
  });

  // The two ways the tool can hold a token and still learn nothing. Both go
  // through `fail()`, which is where the whole no-permissive-default doctrine was
  // first applied — and it is reachable here without a network by putting a stub
  // `curl` in front of the real one.
  const withStubCurl = (script: string) => {
    const dir = makeTmpDir("adversarial-curl");
    fs.writeFileSync(path.join(dir, "curl"), script, { mode: 0o755 });
    try {
      return spawnSync(process.execPath, [SCRIPT, "4242", "--check"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_TOKEN: "token 1",
          PATH: `${dir}:${process.env.PATH}`,
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("exits 2 when the request cannot run at all", () => {
    const run = withStubCurl("#!/bin/sh\nexit 7\n");
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("cannot decide, so not deciding");
  });

  it("exits 2 when the response is not JSON", () => {
    const run = withStubCurl("#!/bin/sh\necho 'a proxy error page'\n");
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("non-JSON body");
  });

  it("exits 2 when the PR number does not resolve", () => {
    const run = withStubCurl('#!/bin/sh\necho \'{"message":"Not Found"}\'\n');
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("did not resolve");
  });

  it("guards its CLI entry so importing it does not curl GitHub", () => {
    // This whole file imports the script. Without the guard, every `npm test`
    // would run `--check` against argv it never meant to parse. The guard is the
    // reason, and guards get deleted.
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("pathToFileURL(path.resolve(process.argv[1])).href");
  });
});

// ---------------------------------------------------------------------------

// THE HOLE #3039 RECORDED, AND WHAT CLOSING IT COSTS (#3044).
//
// A diff that only DELETES assertions from a test changes no runtime line and can
// still remove a guard — the safety gates here are substantially enforced by tests.
// The regression case is SYNTHETIC and says so: no merged PR in either of #3039's
// windows deletes an assertion from a safety scan test. The one real PR the rule
// newly brings into scope is #2963, "Remove useless test assertions" (26 removed
// across 12 files), and it is pinned below because it stays `ordinary` — scope only
// lets the TEXT tier look, and #2963's prose names no safety term.
describe("a diff that only removes assertions is in scope (#3044)", () => {
  const patch = (...lines: string[]) =>
    ["@@ -1,4 +1,4 @@", ...lines].join("\n");

  it.each([
    [
      "a removed assertion",
      patch(
        ' it("x", () => {',
        '-  expect(cores).toContain("alcohol");',
        " });"
      ),
      ["lib/__tests__/adult-only-writes-scan.test.ts"],
    ],
    ["an added assertion", patch('+  expect(cores).toContain("alcohol");'), []],
    [
      "one removed, two added",
      patch(
        "-  expect(a).toBe(1);",
        "+  expect(a).toBe(1);",
        "+  expect(b).toBe(2);"
      ),
      [],
    ],
    [
      "two removed, one added",
      patch(
        "-  expect(a).toBe(1);",
        "-  expect(b).toBe(2);",
        "+  expect(a).toBe(1);"
      ),
      ["lib/__tests__/adult-only-writes-scan.test.ts"],
    ],
    [
      "the diff headers alone, which start with - and + but are not content",
      [
        "--- a/lib/__tests__/adult-only-writes-scan.test.ts",
        "+++ b/lib/__tests__/adult-only-writes-scan.test.ts",
      ].join("\n"),
      [],
    ],
    [
      "no patch at all — the API omits one for a binary or oversized file",
      undefined,
      [],
    ],
  ])("%s", (_label, body, expected) => {
    const file = "lib/__tests__/adult-only-writes-scan.test.ts";
    expect(
      weakenedTests([file], body === undefined ? {} : { [file]: body })
    ).toEqual(expected);
  });

  const DELETION = {
    "lib/__tests__/adult-only-writes-scan.test.ts":
      '@@ -1,3 +1,2 @@\n-  expect(ADULT_ONLY_WRITE_CORES).toContain("alcohol");\n',
  };
  const SAFETY_WORDED = [
    {
      where: "PR title",
      text: "Drop a stale adult-only assertion from the write-core scan",
    },
  ];
  const NEUTRAL = [
    { where: "PR title", text: "Remove useless test assertions" },
  ];

  it.each([
    [
      "a safety-worded assertion deletion is CONSULT",
      SAFETY_WORDED,
      DELETION,
      "CONSULT",
    ],
    // The same diff read by a caller that supplies no patches — every pre-#3044
    // call site — must behave exactly as it did before.
    [
      "the same diff with no patch text supplied stays ordinary",
      SAFETY_WORDED,
      undefined,
      "ordinary",
    ],
    // #2963's real shape: in scope under the new rule, and still ordinary, because
    // scope only decides whether the TEXT tier is allowed to look.
    [
      "#2963's neutral prose over the same deletion stays ordinary",
      NEUTRAL,
      DELETION,
      "ordinary",
    ],
  ])("%s", (_label, sources, patches, verdict) => {
    expect(
      classify({
        files: ["lib/__tests__/adult-only-writes-scan.test.ts"],
        sources,
        patches,
      }).verdict
    ).toBe(verdict);
  });
});

describe("the rule is stated in the file as a test, not as precedents", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");

  it("states the membership test a future editor applies to the vocabulary", () => {
    expect(src).toContain("The test a\n// future editor applies");
    // Numbered steps, not a list of the PRs that happened to be missed.
    for (const step of ["//   1.", "//   2.", "//   3."]) {
      expect(src).toContain(step);
    }
  });

  it("states the measured false-CONSULT rate, with its window", () => {
    expect(src).toContain("THE MEASURED COST");
    expect(src).toMatch(/#2842–#3036/);
    expect(src).toMatch(/#2634–#2841/);
    expect(src).toMatch(/6\.8%/);
    expect(src).toMatch(/5\.0%/);
    expect(src).toMatch(/5\.9%/);
  });

  it("states what admitting assertion deletions measured, on both windows", () => {
    expect(src).toContain("WHY DELETIONS AND NOT TEST FILES");
    expect(src).toMatch(/12\.3%/);
    expect(src).toMatch(/6\.8% tuning and 5\.8% held out/);
  });

  it("says where the exit codes differ, because 2 and 3 both refuse", () => {
    expect(src).toContain("A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER");
    expect(src).toContain("refusals of DIFFERENT");
  });
});
