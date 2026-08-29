// A HAND-RUN OF THE E2E SEED MUST NOT LEAVE A LIVE SESSION COOKIE WHERE GIT CAN
// SEE IT (#3948).
//
// e2e/seed/session.ts mints the admin session every Playwright worker starts
// with and writes it as a Playwright storageState — a file holding a live
// `__Host-ht_session` cookie. It used to write that file into `process.cwd()`,
// which is the template directory under `global-setup` and the REPOSITORY ROOT
// when you run the composed seed by hand to answer a fixture question. Nothing
// in .gitignore covered a bare `auth.json` there, so the credential sat
// untracked in the working tree, one `git add -A` from a commit.
//
// Both halves are asserted here because either alone is a defence that depends
// on the other being right: WHERE the seed writes, and whether git would take it
// if the seed ever gets that wrong again.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The seed mints a REAL session, so it needs the real lib/auth. The tier's shared
// setup (lib/__action_tests__/setup.ts) replaces that module with an
// acting-session stand-in that exposes no createSession, and this is the one file
// in the tier that wants the genuine article. Un-mocking also routes this file to
// the isolated project (vitest.isolation.ts), which is correct: a per-file
// registry change is exactly what that scan is for.
vi.unmock("@/lib/auth");

import { dbFilePath } from "@/lib/db";
import { seedWorkerSession } from "../../e2e/seed/session";
import { AUTH_BASENAME } from "../../e2e/worker-env";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** Would git take this path if it appeared? `check-ignore` answers for paths that don't exist yet. */
function ignored(rel: string): boolean {
  return (
    spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO }).status === 0
  );
}

describe("the seeded storage state", () => {
  it("lands beside its database, never in the cwd", () => {
    const beside = path.join(path.dirname(dbFilePath()), AUTH_BASENAME);
    const atCwd = path.join(process.cwd(), AUTH_BASENAME);
    fs.rmSync(beside, { force: true });
    // Existence BEFORE, not `false`: a developer's stale hand-run artifact must
    // fail this on what the seed did, not on what was already lying around.
    const cwdHadOne = fs.existsSync(atCwd);

    seedWorkerSession();

    expect(fs.existsSync(beside)).toBe(true);
    expect(fs.existsSync(atCwd)).toBe(cwdHadOne);
    // …and it really is the credential, which is why the destination matters.
    const state = JSON.parse(fs.readFileSync(beside, "utf8"));
    expect(state.cookies.map((c: { name: string }) => c.name)).toContain(
      "__Host-ht_session"
    );
  });

  // Every directory the write can reach, plus the bare root filename the old bug
  // produced. The last case is the converse: a `.gitignore` broad enough to
  // swallow the tree would satisfy all the others and nothing else would notice.
  it.each([
    ["auth.json", true],
    ["data/auth.json", true],
    ["e2e/.data/port-3100/template/auth.json", true],
    ["lib/csp.ts", false],
  ])("git ignores %s: %s", (rel, expected) => {
    expect(ignored(rel)).toBe(expected);
  });
});
