import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readManifest, VERSIONS_DIR } from "../migrations/manifest";
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
// UNDER THE SOURCE TREES IT IS NOT ALLOWED AT ALL (#5954). Git's binary heuristic
// looks for a NUL in the first 8000 bytes of EITHER blob, and a file it calls binary
// diffs as `Bin 9033 -> 10437 bytes` with no hunks: `git diff --stat`, the hunk-
// reading checks and every `git diff | grep` read a change to it as nothing. A
// registry entry keeps a raw NUL honest for a sweep; it cannot keep one reviewable.
//
// The one exemption is a file lib/migrations/manifest.json hash-pins. Those bytes
// are frozen by the manifest and by migration-immutability.test.ts, so no edit can
// respell the NUL, and the refusal below has nothing it could ask for. The guard
// reads the manifest to decide that, so what is exempt is what is actually pinned.
//
// THE CHECK IS A BYTE READ, deliberately. `grep -P '\x00'` was the first thing tried
// on the tracker and it reported all three known files clean, and `rg -l $'\0'` is
// worse than useless — bash cannot put a NUL in an argument, so that collapses to an
// empty pattern matching every file in the tree. Only reading the bytes answers the
// question.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The repo-relative paths the immutability manifest hash-pins.
 *
 * READ FROM THE MANIFEST, never copied into a list here: a migration that ships
 * tomorrow is exempt the day its hash lands, and one that has not shipped is not
 * exempt for sitting in the same directory. `readManifest()` is the single spelling
 * of that file (lib/migrations/manifest.ts), keyed by bare filename.
 */
function hashPinned(): Set<string> {
  const versions = path.relative(REPO, VERSIONS_DIR);
  return new Set(
    Object.keys(readManifest()).map((file) => `${versions}/${file}`)
  );
}

/**
 * What the guard says about an exempt file that carries a NUL.
 *
 * It names the rule and stops. Advising the escape spelling here would be advice
 * nobody is allowed to take, and the reader would then either edit an immutable
 * file or quiet the guard instead (#5954, ruling 40a).
 */
const immutableNote = (relative: string): string =>
  `${relative} carries a NUL and is exempt: lib/migrations/manifest.json hash-pins ` +
  `it, so the file is immutable (lib/migrations/AGENTS.md:5, CLAUDE.md:45) and stays ` +
  `exactly as it shipped. A schema change is a new migration, never an edit to this one.`;

/**
 * Files that carry a literal NUL on purpose, each with the reason it is there.
 *
 * Adding an entry is a deliberate act with a sentence attached. Prefer the `\u0000`
 * escape in new code where you can: it produces the identical byte at runtime and
 * leaves the FILE plain text, so no sweep loses sight of it.
 */
const PNG_EVIDENCE =
  "binary PNG evidence for a reviewed before/after comparison";

const DELIBERATE_NULS: Record<string, string> = {
  "lib/migrations/versions/038-food-habit-unique.ts":
    "shipped and hash-pinned, so the bytes stay as they are (lib/migrations/AGENTS.md:5); the NUL is a composite key over profile id and habit scope value",
  "lib/migrations/versions/20260812-saved-biomarker-backed.ts":
    "shipped and hash-pinned, so the bytes stay as they are (lib/migrations/AGENTS.md:5); the NUL is a composite key over profile id and biomarker family",
  "e2e/video-fixture.ts":
    "literal bytes of a synthetic QuickTime atom, where a zero byte is the format",
  "screenshots/5521/after/dose-1280.png": PNG_EVIDENCE,
  "screenshots/5521/after/dose-390.png": PNG_EVIDENCE,
  "screenshots/5521/after/measurements-1280.png": PNG_EVIDENCE,
  "screenshots/5521/after/measurements-390.png": PNG_EVIDENCE,
  "screenshots/5521/after/mood-1280-bottom-reach.png": PNG_EVIDENCE,
  "screenshots/5521/after/mood-1280.png": PNG_EVIDENCE,
  "screenshots/5521/after/mood-390.png": PNG_EVIDENCE,
  "screenshots/5521/after/practice-1280.png": PNG_EVIDENCE,
  "screenshots/5521/after/practice-390.png": PNG_EVIDENCE,
  "screenshots/5521/before/dose-1280.png": PNG_EVIDENCE,
  "screenshots/5521/before/dose-390.png": PNG_EVIDENCE,
  "screenshots/5521/before/measurements-1280.png": PNG_EVIDENCE,
  "screenshots/5521/before/measurements-390.png": PNG_EVIDENCE,
  "screenshots/5521/before/mood-1280.png": PNG_EVIDENCE,
  "screenshots/5521/before/mood-390.png": PNG_EVIDENCE,
  "screenshots/5521/before/practice-1280.png": PNG_EVIDENCE,
  "screenshots/5521/before/practice-390.png": PNG_EVIDENCE,
  "screenshots/5663/after/measurements-390-door-closed.png": PNG_EVIDENCE,
  "screenshots/5663/after/measurements-390-door-open.png": PNG_EVIDENCE,
  "screenshots/5663/after/measurements-390-logged.png": PNG_EVIDENCE,
  "screenshots/5663/after/stool-1280.png": PNG_EVIDENCE,
  "screenshots/5663/after/stool-390-12h.png": PNG_EVIDENCE,
  "screenshots/5663/after/stool-390.png": PNG_EVIDENCE,
};

/** Where a NUL is refused, registered or not, unless the manifest pins it. */
const SOURCE_DIRS = ["app/", "components/", "lib/", "scripts/"];

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
  const immutable = hashPinned();

  it("finds no NUL outside the registry", () => {
    const unregistered = [...found]
      .filter(([relative]) => !(relative in DELIBERATE_NULS))
      .map(([relative, offsets]) =>
        immutable.has(relative)
          ? `${immutableNote(relative)} Record it in DELIBERATE_NULS with that ` +
            `reason, so a sweep still knows the byte is there.`
          : `${relative} (byte ${offsets.join(", ")}) — ripgrep now SKIPS this file ` +
            `in a default search. Spell the NUL as \\u0000 to keep the file text, or ` +
            `add it to DELIBERATE_NULS with the reason it must be a raw byte.`
      );
    expect(unregistered).toEqual([]);
  });

  it("refuses a NUL under a source directory the manifest does not pin", () => {
    // The fix is the escape spelling, which the census’s reach proves is text, and
    // a hash-pinned file is exempt because that fix cannot reach it — not because a
    // pair of paths is remembered here. Registered or not is irrelevant: a registry
    // entry records a NUL, it does not license one under the source trees.
    const refused = [...found]
      .filter(
        ([relative]) =>
          SOURCE_DIRS.some((d) => relative.startsWith(d)) &&
          !immutable.has(relative)
      )
      .map(
        ([relative, offsets]) =>
          `${relative} (first NUL at byte ${offsets[0]}) — git diffs this file as ` +
          `binary once a NUL reaches its first 8000 bytes; spell it \\u0000.`
      );
    expect(refused).toEqual([]);
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
