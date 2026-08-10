import fs from "node:fs";
import path from "node:path";

// WHICH SPECS CANNOT SHARE A MODULE REGISTRY — decided by scanning, so a test
// author never has to know this list exists.
//
// Both unit tiers run most specs with `isolate: false`: one module graph per
// worker instead of per file, which is where the bulk of their speed comes from.
// Two things genuinely cannot work that way, and both are mechanically visible in
// the source:
//
//   vi.mock(       — a shared registry cannot re-mock a module an earlier file
//                    already evaluated. (The SETUP files' own vi.mock calls are
//                    fine: they are identical for every file in the tier and the
//                    spies they install are stable instances, so nothing varies
//                    per file. It is a per-SPEC mock that breaks.)
//   process.chdir( — worker threads reject it outright, and even on `forks` the
//                    directory change would outlive the file and follow every
//                    later spec in that worker.
//
// Scanning rather than hand-keeping a list is the whole point: adding either of
// these to a spec silently routes it to the isolated project, where it behaves
// exactly as the tier did before. A hand-kept list would instead let the spec
// land in the shared project and fail with something unrecognisable — "not
// supported in workers", or an assertion against a spy nothing called.
const CANNOT_SHARE = ["vi.mock(", "process.chdir("];

export function specsNeedingIsolation(
  root: string,
  dirs: readonly string[]
): string[] {
  const specs: string[] = [];
  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
      const file = path.join(entry.parentPath, entry.name);
      const src = fs.readFileSync(file, "utf8");
      if (!CANNOT_SHARE.some((marker) => src.includes(marker))) continue;
      specs.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  return specs;
}
