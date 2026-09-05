// The repository as data, for the reconciliation toolchain (#865, #3619).
//
// EXTRACTED SO THE TWO HALVES ASK THE SAME QUESTION. The scan half
// (`reconcile-tracker.ts`) reads main to decide whether an issue's cited path or
// symbol still exists; the apply half (`reconcile-apply.ts`) now has to ask the
// same thing again, because a `symbol-refresh` refuses when the tree disagrees
// with the rename it was handed (#3619). Two copies of "does this identifier
// exist on main" would be two answers waiting to disagree, and the disagreement
// would show up as a patch that lands where the report said it would refuse.
//
// READ-ONLY, and there is nothing here that could be otherwise: it lists tracked
// files and reads them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RepoIndex } from "./reconcile-tracker-core";

/**
 * Contents are read lazily and memoized: a sweep opens a few hundred of ~3,000
 * tracked files, and reading them all up front is seconds of work for nothing.
 */
export function buildRepoIndex(root: string): RepoIndex {
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  // The revision the file list came from. Read HERE rather than at report or
  // summary time: the tracker moves hourly and so does this checkout, and a
  // SHA read later names a tree the run never looked at.
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const cache = new Map<string, string | null>();
  return {
    commit,
    files,
    read(file: string): string | null {
      const hit = cache.get(file);
      if (hit !== undefined) return hit;
      let text: string | null = null;
      try {
        const stat = fs.statSync(path.join(root, file));
        // A binary blob has nothing to anchor and would only slow the scan.
        if (stat.isFile() && stat.size < 4 * 1024 * 1024) {
          text = fs.readFileSync(path.join(root, file), "utf8");
        }
      } catch {
        text = null;
      }
      cache.set(file, text);
      return text;
    },
  };
}
