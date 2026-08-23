import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// A LITERAL NUL IN A SOURCE FILE MAKES THAT FILE INVISIBLE TO A DEFAULT GREP (#3206).
//
// A handful of files use a NUL as a composite-key separator — `${profile_id}\0${key}`
// — which is the right tool: no user string can contain one, so a value carrying the
// delimiter cannot forge a key. Nothing below is a defect, and none of it changes.
//
// The consequence is a tooling one. ripgrep classifies a file holding a NUL as BINARY
// and SKIPS it in a default search, so a census run as `rg <pattern>` omits these files
// and reports a clean sweep it never took. This repo decides what to fix by exactly
// that kind of sweep ("every surface that counts activity rows", "every caller of this
// helper"), and two of the files below are MIGRATIONS — the category where a missed
// occurrence is least recoverable.
//
// So the set is pinned rather than left to grow quietly. Adding a NUL to a file is
// still allowed; doing it silently is not.
//
// THE CHECK IS A BYTE READ, deliberately. `grep -P '\x00'` was the first thing tried
// on the tracker and it reported all three known files clean, and `rg -l $'\0'` is
// worse than useless — bash cannot put a NUL in an argument, so that collapses to an
// empty pattern matching every file in the tree. Only reading the bytes answers the
// question.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Files that carry a literal NUL on purpose, each with the reason it is there.
 *
 * Adding an entry is a deliberate act with a sentence attached. Prefer the `\u0000`
 * escape in new code where you can: it produces the identical byte at runtime and
 * leaves the FILE plain text, so no sweep loses sight of it.
 */
const DELIBERATE_NULS: Record<string, string> = {
  "lib/__db_tests__/api-portals-route.test.ts":
    "joins a response body's strings on NUL so a disclosure assertion cannot match across two adjacent fields",
  "lib/__tests__/api-token-format.test.ts":
    "a NUL-bearing token is one of the hostile inputs the token parse must refuse",
  "lib/__tests__/biomarker-panel-groups.test.ts":
    "composite key: profile id and biomarker name key",
  "lib/integrations/sync-log.ts": "composite key: profile id and source id",
  "lib/migrations/versions/038-food-habit-unique.ts":
    "composite key: profile id and habit scope value",
  "lib/migrations/versions/20260812-saved-biomarker-backed.ts":
    "composite key: profile id and biomarker family",
  "lib/queries/coverage.ts": "composite key: item kind and item key",
  "lib/video/fixture.ts":
    "literal bytes of a synthetic QuickTime atom, where a zero byte is the format",
  "scripts/orchestration/reconcile-tracker-core.ts":
    "composite key: issue file and citation path",
  "scripts/phi-scan.ts":
    "a placeholder sentinel, held while a glob's `**` is rewritten, that no glob can itself contain",
};

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/** Byte offsets of every NUL in a file. The only honest way to ask. */
function nulOffsets(absolutePath: string): number[] {
  const bytes = readFileSync(absolutePath);
  const offsets: number[] = [];
  for (let i = bytes.indexOf(0); i !== -1; i = bytes.indexOf(0, i + 1))
    offsets.push(i);
  return offsets;
}

function census(files: string[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const relative of files) {
    const offsets = nulOffsets(path.join(REPO, relative));
    if (offsets.length > 0) found.set(relative, offsets);
  }
  return found;
}

describe("the NUL-byte census", () => {
  const found = census(trackedFiles());

  it("finds no NUL outside the registry", () => {
    const unregistered = [...found]
      .filter(([relative]) => !(relative in DELIBERATE_NULS))
      .map(
        ([relative, offsets]) =>
          `${relative} (byte ${offsets.join(", ")}) — ripgrep now SKIPS this file ` +
          `in a default search. Spell the NUL as \\u0000 to keep the file text, or ` +
          `add it to DELIBERATE_NULS with the reason it must be a raw byte.`
      );
    expect(unregistered).toEqual([]);
  });

  it("keeps the registry from outliving the bytes it describes", () => {
    // The other direction, so a file that loses its NUL leaves the list rather than
    // sitting there implying a constraint nothing enforces.
    expect([...found.keys()].sort()).toEqual(
      Object.keys(DELIBERATE_NULS).sort()
    );
  });
});

describe("the census's reach", () => {
  // A green census over a tree that happens to comply proves nothing about what the
  // census can SEE, so it is run over files written to break it.
  const dir = makeTmpDir("nul-census");
  const write = (name: string, content: string): string => {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  };

  const NUL = "\u0000";

  it("sees a raw NUL wherever it sits, including at the very first byte", () => {
    expect(nulOffsets(write("lead.ts", `${NUL}const a = 1;\n`))).toEqual([0]);
    const key = `const k = a + "${NUL}" + b + "${NUL}";\n`;
    expect(nulOffsets(write("mid.ts", key))).toEqual([15, 25]);
  });

  it("passes the ESCAPE spelling, which is the fix it recommends", () => {
    // `"\u0000"` builds the same byte at runtime and leaves the file plain text —
    // readable by every sweep, and needing no exemption. That is the whole reason the
    // failure message points at it.
    const escaped = write("escaped.ts", 'const sep = "\\u0000";\n');
    expect(nulOffsets(escaped)).toEqual([]);
    expect(readFileSync(escaped, "utf8")).toContain("\\u0000");
  });
});
