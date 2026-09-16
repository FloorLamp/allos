// WHERE the DB tier's template lives has to be decided by the template's own
// inputs, not by the checkout that asks for it (#5893).
//
// `process.cwd()` reads like isolation and is not. A parallel lane's worktree
// symlinks `node_modules` at the main checkout's, which is where the cache sits,
// so every worktree composes a path to ONE physical file. Two lanes with
// different migration sets then take turns rebuilding it and clearing it out
// from under each other's workers: measured once at 574 of 911 files failing
// `ENOENT … copyfile … template.db`, a mass red naming nothing the lane changed.
//
// These cases drive `templateDbPath()` against real directories and assert what
// the two checkouts END UP HOLDING, never the shape of the path. A later
// refactor is free to move the cache anywhere it likes; what it may not do is
// put two different migration sets back on one file, or split one migration set
// across two — the second is the ~0.8s rebuild-on-every-run this cache exists to
// avoid.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  TEMPLATE_INPUT_DIRS,
  TEMPLATE_INPUT_FILES,
  templateDbPath,
} from "@/lib/__db_tests__/shared-template";
import { makeTmpDir } from "./tmp-dir";

/**
 * A checkout just complete enough to be fingerprinted, with `node_modules`
 * symlinked at a shared target — the parallel-lane setup the bug needs.
 *
 * The inputs come from the exported lists rather than a second copy of them, so
 * a new template input cannot leave this fixture fingerprinting a partial tree.
 */
function makeCheckout(sharedNodeModules: string, migration: string): string {
  const root = makeTmpDir("db-template-checkout");
  for (const dir of TEMPLATE_INPUT_DIRS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "20260101-only.ts"), migration);
  }
  for (const file of TEMPLATE_INPUT_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "");
  }
  fs.symlinkSync(sharedNodeModules, path.join(root, "node_modules"));
  return root;
}

/** Put a template where this checkout asks for one, as globalSetup would. */
function buildTemplate(root: string, bytes: string): void {
  const target = templateDbPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

/** What this checkout's workers would copy, or the read error they would hit. */
function readTemplate(root: string): string {
  return fs.readFileSync(templateDbPath(root), "utf8");
}

const ONE_MIGRATION = "export const up = () => {};\n";
const ANOTHER_MIGRATION = "export const up = () => {\n  // and a column\n};\n";

describe("db-tier template cache", () => {
  it("leaves each checkout its own template when their migration sets differ", () => {
    const shared = makeTmpDir("db-template-node-modules");
    const branch = makeCheckout(shared, ANOTHER_MIGRATION);
    const main = makeCheckout(shared, ONE_MIGRATION);

    buildTemplate(main, "template-built-by-main");
    buildTemplate(branch, "template-built-by-branch");

    // Before the fix the second build landed on the first's file: `main` read
    // back the branch's bytes, and a build that cleared the destination first
    // left `main`'s workers with no file to copy at all.
    expect(readTemplate(main)).toBe("template-built-by-main");
    expect(readTemplate(branch)).toBe("template-built-by-branch");
  });

  it("hands two checkouts with the same migration set one template, so an unchanged run still reuses it", () => {
    const shared = makeTmpDir("db-template-node-modules");
    const first = makeCheckout(shared, ONE_MIGRATION);
    const second = makeCheckout(shared, ONE_MIGRATION);

    buildTemplate(first, "template-built-once");

    // Isolating on anything per-run or per-checkout — a pid, a timestamp, the
    // cwd — would pass the case above and silently rebuild here instead, which
    // costs exactly the ~0.8s saving the cache is for.
    expect(readTemplate(second)).toBe("template-built-once");
  });
});
