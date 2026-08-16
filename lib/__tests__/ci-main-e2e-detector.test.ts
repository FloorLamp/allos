import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Two documents that must stay in step (#2969, ruled 2026-08-16).
//
// `ci-main.yml`'s header argues the browser matrix should not run per merge.
// `e2e-main.yml` runs one. Both statements were true at once on main, and the
// defect was not the workflow — the owner authorized it — but the header left
// arguing against it: an implementer reading that header would reasonably
// conclude e2e-main.yml is a mistake and delete the only e2e coverage main has.
//
// Prose cannot be tested for being persuasive, so this tests the narrow thing
// that actually matters: while a per-merge browser matrix exists, the header
// must record that the objection is superseded, why, and — the half that is
// easiest to lose in an edit — that it is superseded ONLY for a detector, never
// for a gate. Drop the workflow and this guard goes with it, which is the right
// coupling: the record exists because the workflow does.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const read = (p: string) =>
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", p), "utf8");

describe("the post-merge e2e detector and ci-main.yml's header", () => {
  const e2eMainPath = path.join(
    repoRoot,
    ".github",
    "workflows",
    "e2e-main.yml"
  );

  it("still runs a browser matrix on every push to main", () => {
    expect(fs.existsSync(e2eMainPath)).toBe(true);
    const e2eMain = read("e2e-main.yml");
    expect(e2eMain).toContain("branches: [main]");
    expect(e2eMain).toMatch(/matrix:\s*\n\s*shard:/);
  });

  it("records in ci-main.yml that the objection is superseded, and by what", () => {
    const ciMain = read("ci-main.yml");
    expect(ciMain).toMatch(/SUPERSEDED/);
    // The ruling, and the receipt it rests on — two PRs green on their own
    // heads merging into a red main.
    expect(ciMain).toContain("#2969");
    expect(ciMain).toContain("#2791");
  });

  it("keeps the supersession SCOPED to a detector, not a gate", () => {
    // The objection still stands against promoting the matrix to a per-merge
    // gate. A record that drops the scope authorizes more than was ruled.
    const ciMain = read("ci-main.yml");
    expect(ciMain).toMatch(/GATE/);
    expect(ciMain).toMatch(/detector/i);
  });
});
