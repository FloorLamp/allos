import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../error-log-format";

// THE OVER-REDACTION CORPUS (#2965, required by the #3000 review).
//
// The vendor-prefix list in `error-log-format.ts` is a DENYLIST, which is the
// design #2955 deliberately replaced. It was granted as an exception on one
// stated condition — the three-condition rule, whose second condition is that
// nothing this app logs can begin with a listed prefix and carry a body on it.
// Until now that condition was a COMMENT. Nothing executed it, so the sole
// guardrail the exception rests on could not fail.
//
// This executes it, against the app's own vocabulary rather than against a
// hand-picked handful: every string leaf and key from the 30 dataset JSONs,
// the canonical result definitions and the exercise guides, plus every
// identifier-shaped token in `lib/` and `scripts/`. ~67k distinct strings in
// ~2s, and the assertion is that redaction is the IDENTITY on all of them but a
// listed few.
//
// WHY IDENTITY RATHER THAN A LIVE DIFF AGAINST `origin/main`. The review that
// required this ran the corpus through both trees and compared. A repo test
// cannot: `main` moves, and re-importing another checkout's module from a test
// is slow and fragile. Identity is the stronger and more durable form — it
// catches over-redaction whoever introduced it — which is why the pre-existing
// difference below has to be written down instead of silently subtracted.
//
// TEST FILES ARE NOT VOCABULARY and are excluded from the token scan. They
// deliberately contain prefix- and credential-shaped strings, because they are
// this rule's own POSITIVE fixtures; feeding those back in as "benign app
// vocabulary" would make this corpus assert that the redaction rule does not
// work.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

// Strings this corpus is known to mutate. Each one is a defect somewhere, and
// each is recorded here rather than filtered out silently, so the list is a
// LEDGER and shrinking it is visible. The assertion below is EXACT — an entry
// that stops mutating fails this test too, which is how the ledger stays true.
const KNOWN_DIFFERENCES = [
  {
    // PRE-EXISTING, and present on `origin/main` byte-identically — verified by
    // running this corpus through both trees during the #3000 fix round. Not
    // attributable to the vendor-prefix list.
    //
    // `Digest` is an HTTP auth scheme, so `AUTH_SCHEME_RE` masks what follows
    // it. In "…helps digest carbohydrates." the following word is encoded
    // enough for `looksLikeAuthCredential` (the trailing full stop is a
    // non-letter), so the sentence loses its last two words. Harmless where it
    // occurs — a biomarker description is not an error string — and fixing it
    // means tightening a rule that guards a real auth header, which is a
    // separate change with its own risk.
    source: "lib/datasets/data/biomarker-descriptions.json",
    contains: "helps digest carbohydrates",
    expectMasked: "helps digest ***",
  },
] as const;

function collectJsonStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value))
    for (const v of value) collectJsonStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectJsonStrings(v, out);
    }
  }
}

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      // See the header: this rule's own fixtures are not app vocabulary.
      if (
        e.isDirectory() &&
        (e.name === "__tests__" || e.name.endsWith("_tests__"))
      ) {
        continue;
      }
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function buildCorpus(): Set<string> {
  const strings = new Set<string>();
  const jsonFiles = [
    ...fs
      .readdirSync(path.join(repoRoot, "lib", "datasets", "data"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(repoRoot, "lib", "datasets", "data", f)),
    path.join(repoRoot, "lib", "canonical-result-definitions.json"),
    path.join(repoRoot, "lib", "exercise-guides.json"),
  ];
  for (const f of jsonFiles) {
    collectJsonStrings(JSON.parse(fs.readFileSync(f, "utf8")), strings);
  }
  // Identifier-shaped tokens: the shape a prefix rule is most likely to eat.
  const token = /[A-Za-z][A-Za-z0-9_-]{3,}/g;
  const srcFiles = [
    ...filesUnder(path.join(repoRoot, "lib"), [".ts", ".tsx", ".json"]),
    ...filesUnder(path.join(repoRoot, "scripts"), [
      ".ts",
      ".mjs",
      ".js",
      ".sh",
    ]),
  ];
  for (const f of srcFiles) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(token))
      strings.add(m[0]);
  }
  return strings;
}

describe("redactSecrets over the app's own vocabulary (#2965 guardrail)", () => {
  const corpus = [...buildCorpus()];

  it("collected a corpus large enough for its absence to be a failure", () => {
    // Without this, a broken walk turns every assertion below into a green over
    // an empty set — the shape of guard this whole test exists to replace.
    expect(corpus.length).toBeGreaterThan(50_000);
    // Both halves of the corpus proven present, so a half that stopped being
    // collected cannot hide behind the other half's size.
    expect(corpus).toContain("Amylase"); // a dataset JSON leaf
    expect(corpus).toContain("profile_id"); // an identifier token from lib/
  });

  it("leaves every string in it byte-identical, but the recorded few", () => {
    const mutated: string[] = [];
    for (const s of corpus) {
      if (redactSecrets(s) !== s) mutated.push(s);
    }
    // EXACT, in both directions. An unrecorded mutation is over-redaction in a
    // string a data subject may be shown (#2935); a recorded one that stopped
    // mutating means the ledger above is stale.
    expect(mutated).toHaveLength(KNOWN_DIFFERENCES.length);
    for (const known of KNOWN_DIFFERENCES) {
      const hit = mutated.filter((s) => s.includes(known.contains));
      expect(hit).toHaveLength(1);
      expect(redactSecrets(hit[0])).toContain(known.expectMasked);
    }
  });

  it("is idempotent over the whole corpus, not just over a fixture", () => {
    // One assertion over a collected list, not one per string: 67k `expect`
    // calls cost more than the 134k redactions they check, and this tier is
    // shared. Same coverage, and the failure still names the string.
    const notIdempotent: string[] = [];
    for (const s of corpus) {
      const once = redactSecrets(s);
      if (redactSecrets(once) !== once) notIdempotent.push(s);
    }
    expect(notIdempotent).toEqual([]);
  });

  it("still masks a vendor-prefixed credential planted in that vocabulary", () => {
    // The corpus proves the rule is quiet. This proves quiet is not the same as
    // switched off — a rule that redacted nothing would pass everything above.
    const planted = [
      `${["sk", "live", ""].join("_")}abc123DEADBEEF456xyz`,
      `${["ghp", ""].join("_")}AAAABBBBCCCCDDDDEEEE1111`,
      `${["sk", "ant", "api03", "AAbbCCddEEffGGhhIIjj"].join("-")}`,
    ];
    for (const p of planted) {
      const inProse = `Basic Metabolic Panel import failed: ${p}`;
      expect(redactSecrets(inProse)).not.toContain(p);
      expect(redactSecrets(inProse)).toContain("Basic Metabolic Panel");
    }
  });
});
