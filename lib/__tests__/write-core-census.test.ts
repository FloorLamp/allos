import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { perTestCeiling } from "../../vitest.timeouts";
import { makeTmpDir } from "./tmp-dir";

// THE WRITE-CORE PREDICATE AND ITS CALLER RESOLUTION, ON A TREE THAT HOLDS STILL.
//
// scripts/write-core-census.mjs answers "which lib modules are write cores, and
// whose row is each one in?" — a question two hand instruments had already answered
// differently, and neither could be audited because auditing one meant writing a
// third. What is worth pinning is therefore NOT a count over this repository, which
// moves under the test with every conversion, but the SHAPES on which the two hand
// instruments disagreed. Each case below is one of them, as a five-line module.
//
// The census is run against a fixture ROOT rather than imported, because
// scripts/reach-graph.ts resolves its root from its own location — which is the
// property that makes it read a whole tree with no configuration. Copying the three
// real files into the fixture and running them is the same code path a reviewer runs,
// and a copy that goes stale fails loudly at import rather than passing quietly.
const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const COPY = [
  "scripts/write-core-census.mjs",
  "scripts/reach-graph.ts",
  "lib/__tests__/strip-comments.ts",
];

const FIXTURE: Record<string, string> = {
  // The two halves of the predicate's write test, in the module that owns them.
  "lib/db.ts": `
export function writeTx<T>(fn: () => T): T { return fn(); }
export function maintenanceWrite(fn: () => void): void { fn(); }
export const db = { prepare: (_sql: string) => ({ run: (..._a: unknown[]) => {} }) };
`,
  "lib/auth.ts": `export type WriteAuthorizedProfileId = number & { __brand: "w" };`,

  // Reached ONLY through a barrel: the shape that fell into the hand instrument's
  // no-caller bucket and pushed tranche A down.
  "lib/direct-write.ts": `
import { db } from "./db";
export function insertThing(profileId: number, name: string): void {
  db.prepare("INSERT INTO things (profile_id, name) VALUES (?, ?)").run(profileId, name);
}
`,
  // No SQL at all — the write is the transaction it opens. A SQL-only predicate
  // misses this one, and it is the shape the programme's first conversion had.
  "lib/tx-write.ts": `
import { writeTx } from "./db";
function bump(_profileId: number): void {}
export function retimeThing(profileId: number): void {
  writeTx(() => bump(profileId));
}
`,
  "lib/barrel.ts": `
export { insertThing } from "./direct-write";
export * from "./tx-write";
`,
  // Called only by a sibling in its own file: the other half of the divergence.
  "lib/same-module.ts": `
import { db } from "./db";
export function stampThing(profileId: number): void {
  db.prepare("UPDATE things SET stamp = 1 WHERE profile_id = ?").run(profileId);
}
export function stampAll(profileId: number, ids: number[]): void {
  for (const _id of ids) stampThing(profileId);
}
`,
  // Two cores in one file: the page names the first ONLY in a type position and
  // calls the second, so "no caller" and "a page caller" are told apart here.
  "lib/typed-only.ts": `
import { db } from "./db";
export function deleteThing(profileId: number, id: number): void {
  db.prepare("DELETE FROM things WHERE id = ? AND profile_id = ?").run(id, profileId);
}
export function purgeThings(profileId: number): void {
  db.prepare("DELETE FROM things WHERE profile_id = ?").run(profileId);
}
`,
  // The DML is a file-level prepared statement, so it is in no declaration's body.
  "lib/hoisted.ts": `
import { db } from "./db";
const CLEAR = db.prepare("UPDATE things SET flag = 0 WHERE profile_id = ?");
export function clearFlag(profileId: number): void { CLEAR.run(profileId); }
`,
  // Already converted: it must leave the census without anyone keeping a list.
  "lib/branded.ts": `
import { db } from "./db";
import type { WriteAuthorizedProfileId } from "./auth";
export function insertBranded(profileId: WriteAuthorizedProfileId): void {
  db.prepare("INSERT INTO things (profile_id) VALUES (?)").run(profileId);
}
`,
  "app/(app)/things/actions.ts": `
import { insertThing, retimeThing } from "@/lib/barrel";
import { stampAll } from "@/lib/same-module";
export async function saveThingAction(profileId: number, name: string) {
  insertThing(profileId, name);
  retimeThing(profileId);
  stampAll(profileId, [1]);
}
`,
  "app/(app)/things/page.tsx": `
import type { deleteThing } from "@/lib/typed-only";
import { purgeThings } from "@/lib/typed-only";
export default function Page(): typeof deleteThing | null {
  purgeThings(1);
  return null;
}
`,
};

interface Core {
  file: string;
  name: string;
  tranche: string;
  naiveTranche: string;
  writesBy: string;
  blockers: string[];
  domains: string[];
}
interface Census {
  cores: Core[];
  delegating: Array<{ file: string; name: string; via: string }>;
  hoisted: Array<{ file: string; name: string }>;
}

let census: Census;
let root: string;

const key = (c: { file: string; name: string }): string =>
  `${c.file}::${c.name}`;
const core = (k: string): Core | undefined =>
  census.cores.find((c) => key(c) === k);

beforeAll(
  () => {
    root = makeTmpDir("write-core-census");
    // Bare specifiers (`typescript-api`) resolve by walking up from the module, so
    // the fixture needs the repository's installed packages reachable from its root.
    fs.symlinkSync(
      path.join(REPO, "node_modules"),
      path.join(root, "node_modules")
    );
    fs.mkdirSync(path.join(root, "components"), { recursive: true });
    for (const [rel, body] of Object.entries(FIXTURE)) {
      fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body.trimStart());
    }
    for (const rel of COPY) {
      fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
    }
    census = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "scripts/write-core-census.mjs"), "--json"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      )
    ) as Census;
  },
  perTestCeiling(2, "green")
);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("the write-core predicate", () => {
  it("counts a core whose only write is the transaction it opens", () => {
    // A SQL-only reading of the predicate drops every delegating core, including
    // the one this programme has already converted.
    expect(core("lib/tx-write.ts::retimeThing")?.writesBy).toBe("writeTx");
  });

  it("drops a core whose profile id is already branded, with no list to maintain", () => {
    expect(core("lib/branded.ts::insertBranded")).toBeUndefined();
  });

  it("reports a delegating core in its own bucket instead of dropping it", () => {
    // Neither DML nor writeTx; it hands its own profile id to something that writes.
    expect(census.delegating.map(key)).toContain(
      "lib/same-module.ts::stampAll"
    );
    expect(core("lib/same-module.ts::stampAll")).toBeUndefined();
  });

  it("does not silently read a file-level prepared statement as a body", () => {
    // The declaration writes, but not in its own text: the predicate as written
    // cannot see it, so it is named rather than counted either way.
    expect(census.hoisted.map(key)).toContain("lib/hoisted.ts::clearFlag");
    expect(core("lib/hoisted.ts::clearFlag")).toBeUndefined();
  });
});

describe("caller resolution", () => {
  it("follows a barrel re-export into tranche A", () => {
    // The hand instrument followed only a named import of the core's OWN module,
    // so this core had no caller at all and landed in the no-caller bucket.
    const c = core("lib/direct-write.ts::insertThing");
    expect(c?.tranche).toBe("A");
    expect(c?.naiveTranche).toBe("N");
    expect(c?.domains).toEqual(["things"]);
  });

  it("follows an `export *` barrel the same way", () => {
    expect(core("lib/tx-write.ts::retimeThing")?.tranche).toBe("A");
  });

  it("counts a same-module call as the lib caller it is", () => {
    // Only a sibling in its own file calls it, which is a lib caller and therefore
    // tranche B — not the "no production caller" the hand instrument recorded.
    const c = core("lib/same-module.ts::stampThing");
    expect(c?.tranche).toBe("B");
    expect(c?.blockers).toEqual(["lib"]);
    expect(c?.naiveTranche).toBe("N");
  });

  it("separates a page that calls a core from one that only names its type", () => {
    // The same page imports both cores from the same module: it CALLS purgeThings
    // and names deleteThing in a type position only. The first assertion is the
    // positive control — a page caller is seen, and is a tranche-B blocker — so the
    // second is a measurement and not a harness that sees nothing at all.
    const called = core("lib/typed-only.ts::purgeThings");
    expect(called?.tranche).toBe("B");
    expect(called?.blockers).toEqual(["page"]);
    expect(core("lib/typed-only.ts::deleteThing")?.tranche).toBe("N");
  });
});
