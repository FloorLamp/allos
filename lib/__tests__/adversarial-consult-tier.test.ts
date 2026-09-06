// The adversarial lane's third answer (#3030).
//
// `adversarial-review-brief.mjs --check` used to have two: 0 for "a declared
// high-stakes path matched" and 1 for everything else. 1 is the code a caller
// reads as "skip the lane", so "I checked, and this is ordinary" and "nobody has
// ever classified this file" arrived as the same word. Five PRs (#2929, #2955,
// #3004, #3018, #3028) were reported as the first when they were the second, and
// all five were caught by an orchestrator overriding the tool by hand.
//
// What is pinned here, and it is now only these two things:
//
//   1. THE FIVE COME BACK CONSULT WITH THE PATH TIER OFF. Each of them matches a
//      declared path TODAY — because a glob was added after each miss, which is
//      the pattern #3030 was filed to stop. Asserting them through `classify()`
//      would therefore assert the four patches, not the new rule. So the
//      regression suite runs the text tier ALONE, which is the property the issue
//      asks for: no fifth glob needed.
//   2. THE EXIT CODES STAY FOUR DISTINCT NUMBERS, and the error path stays 2. A
//      CONSULT collapsed back onto 1 is the original defect returning silently.
//
// WHAT WAS CUT, AND WHY (owner, 2026-09-06): ~1,100 lines pinning the SAFETY
// VOCABULARY and "what counts as a claim" — the measured term list, hyphenated
// compounds, the PHI acronym narrowing, the scope rule's directory table, the
// template-checklist and fenced-block droppers, `sentenceAround`'s windowing,
// the assertion-deletion scope rule, the diff tier's signal tables and the gate
// transcript's heading rules. Every one of those is a JUDGMENT CALL about how
// the classifier should read English, not a regression: they pin a chosen
// wording rather than a defect that escaped. Re-tuning the vocabulary is now a
// change to the tool, checked by running it, rather than a change to the tool
// plus a second copy of its taste in a test.
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
  claimSources,
  classify,
  closingKeywordIssues,
  shipsRuntimeCode,
  vocabularyHits,
} from "../../scripts/orchestration/adversarial-review-brief.mjs";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
  REPO,
  "scripts/orchestration/adversarial-review-brief.mjs"
);

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
        // out equal, the orchestrator has to go read the PR anyway, which is the
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

  // THE FILE-LIST PAGE CAP (#5343). Every HIGH_STAKES path is matched against
  // this list, so a migration sitting on page eleven classifies as `ordinary` —
  // which is exactly what a clean sweep prints. `batch.length < 100` is the
  // exhaustion signal and it used to be spent on a bare `break`, so the two were
  // indistinguishable. Both rows run through the same stub and differ only in how
  // many FULL pages it serves, which is what makes the refusal the truncation
  // talking rather than a constant in the branch.
  const stubFiles = (fullPages: number) =>
    `#!${process.execPath}\n` +
    `const url = process.argv[process.argv.length - 1];\n` +
    `const emit = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };\n` +
    `if (url.includes("/files?")) {\n` +
    `  const page = Number((url.match(/[?&]page=(\\d+)/) ?? [, "1"])[1]);\n` +
    `  emit(page <= ${fullPages}\n` +
    `    ? Array.from({ length: 100 }, (_, i) => ({ filename: "lib/ordinary-" + page + "-" + i + ".ts" }))\n` +
    `    : []);\n` +
    `}\n` +
    `emit({ number: 4242, title: "an ordinary change", body: "no safety vocabulary here" });\n`;

  it("exits 2 when the changed-file list runs out of pages", () => {
    const run = withStubCurl(stubFiles(10));
    expect(run.status).toBe(EXIT.cannotAnswer);
    expect(run.stderr).toContain("changed more files than this reader pages");
  });

  it("still answers ordinary when the file list ended on its own", () => {
    // The converse, through the same fetch: nine full pages plus a short tenth
    // is 900 ordinary files and a real verdict, so the row above is the CAP
    // firing and not the file count.
    const run = withStubCurl(stubFiles(9));
    expect(run.status).toBe(EXIT.ordinary);
    expect(run.stderr).not.toContain(
      "changed more files than this reader pages"
    );
  });

  it("guards its CLI entry so importing it does not curl GitHub", () => {
    // This whole file imports the script. Without the guard, every `npm test`
    // would run `--check` against argv it never meant to parse. The guard is the
    // reason, and guards get deleted.
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("pathToFileURL(path.resolve(process.argv[1])).href");
  });
});
