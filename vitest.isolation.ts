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
//   vi.mock( and its doMock/unmock/doUnmock variants
//                  — a shared registry cannot change a module an earlier file
//                    already evaluated. (The SETUP files' own vi.mock calls are
//                    fine: they are identical for every file in the tier and the
//                    spies they install are stable instances, so nothing varies
//                    per file. It is a per-SPEC registry change that breaks.)
//   process.chdir( — worker threads reject it outright, and even on `forks` the
//                    directory change would outlive the file and follow every
//                    later spec in that worker.
//
// Scanning rather than hand-keeping a list is the whole point: adding either of
// these to a spec silently routes it to the isolated project, where it behaves
// exactly as the tier did before. A hand-kept list would instead let the spec
// land in the shared project and fail with something unrecognisable — "not
// supported in workers", or an assertion against a spy nothing called.
//
// MATCHED AS PATTERNS, NOT AS LITERAL TEXT. These used to be plain substrings, which
// made the detection depend on FORMATTING: Prettier wraps a long chain as `vi\n  .mock(`
// and the marker silently stopped matching, so the spec landed in the shared project and
// produced exactly the unrecognisable failure described above. A marker that a
// reformatting run can switch off is not mechanical.
const CANNOT_SHARE = [
  /vi\s*\.\s*(?:doMock|doUnmock|mock|unmock)\s*\(/,
  /process\s*\.\s*chdir\(/,
];

// The third thing that cannot share a registry, and the one that hid: a spec that
// patches an APP MODULE'S EXPORT through a namespace import
// (`import * as auth from "@/lib/auth"` + `vi.spyOn(auth, …)`).
//
// It is the same defect as a per-spec `vi.mock` and it fails the same way. The consumer
// under test imported that export as its own binding when the worker's ONE module graph
// was built — which, with `isolate: false`, may have happened while an earlier file was
// running, long before this spec installs its spy. Whether the patch is observed then
// depends on the order files were packed into workers, so the spec passes alone, passes
// most of the time in the tier, and fails when the packing changes: the assertion sees
// the REAL function's result and reports a plain wrong value, naming nothing about
// isolation. Spying on `console`, `fs`, `Date` or a db handle is untouched by this —
// those are globals and objects, not registry entries, and they are why the marker is
// the namespace import rather than `spyOn` on its own.
//
// Matched on ANY namespace import, not only `@/`-prefixed ones. Specs use the alias by
// convention, but keying on it would make the detection depend on import STYLE — the
// same species of mistake as keying on formatting, and this scan has now been caught by
// that once. A namespace import of `node:fs` or `vitest` is not an app module, but
// spying on one of those in a shared registry is a per-file mutation of shared state
// too, so routing it to the isolated project is right for the same reason.
function spiesOnAppModule(src: string): boolean {
  for (const m of src.matchAll(/vi\s*\.\s*spyOn\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const ns = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`import\\s*\\*\\s*as\\s+${ns}\\s+from\\s`).test(src))
      return true;
  }
  return false;
}

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
      if (
        !CANNOT_SHARE.some((marker) => marker.test(src)) &&
        !spiesOnAppModule(src)
      )
        continue;
      specs.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  return specs;
}
