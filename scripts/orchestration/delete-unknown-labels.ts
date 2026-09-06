// Label taxonomy enforcement — deletes REPO labels outside `KNOWN_LABELS`.
//
//   npx tsx scripts/orchestration/delete-unknown-labels.ts          # dry run
//   npx tsx scripts/orchestration/delete-unknown-labels.ts --apply  # deletes
//
// Run by .github/workflows/label-taxonomy.yml on label creation/edit, weekly,
// and on demand. GitHub's add-labels endpoint silently CREATES any label it
// does not recognise, so one filing with a synonym mints a stray that the live
// list then serves as precedent for the next filer (16 strays counted
// 2026-08-30). This is the repo-side complement of `checkLabelHygiene`'s
// `unknown-label` finding: the taxonomy's canon is `KNOWN_LABELS` in
// reconcile-tracker-core.ts and the live label list FOLLOWS the code — to add
// a label, extend `KNOWN_LABELS` first and merge; a label created repo-side
// without that lands here, whoever created it.
//
// Deleting a repo label strips it from every issue and PR, open and closed —
// the same remedy the 2026-08-15 retirement used. It cannot strand an issue's
// domain axis: a stray never satisfied `DOMAIN_LABELS`, so any no-domain state
// left behind existed already and `checkLabelHygiene` already flags it.
//
// THE THIRD WRITER in the reconciliation toolchain, and the narrowest: one
// verb, one collection (the repo's own labels), no request body at all. There
// is no issue URL anywhere in this file, so it cannot touch what an issue
// carries except through the repo collection. And it fails CLOSED: a taxonomy
// import that comes back hollow aborts before planning, because against an
// empty set this script's plan is "delete everything".

import "../load-env";
import { execFileSync } from "node:child_process";
import { KNOWN_LABELS } from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

const REPO = "FloorLamp/allos";
const API = `https://api.github.com/repos/${REPO}`;

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
const auth = token ? ["-H", `Authorization: Bearer ${token}`] : [];

function curlJson(url: string): unknown {
  return JSON.parse(
    execFileSync("curl", ["-sS", "--fail-with-body", ...auth, url], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
  );
}

/** The response STATUS, not the body — a delete has no body to read. */
function curlDeleteStatus(url: string): string {
  return execFileSync(
    "curl",
    [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-X",
      "DELETE",
      ...auth,
      url,
    ],
    { encoding: "utf8" }
  ).trim();
}

/**
 * This one CANNOT truncate, on two counts (#5343 censused it as one of eight
 * pagers that discard `batch.length < 100`). Structurally: the loop has no page
 * cap, a page past the end is `[]` which is short, and `--fail-with-body` makes
 * `curlJson` throw on any non-2xx rather than return a short page. And by size:
 * `curl .../labels?per_page=100` counted 39 live labels on 2026-09-05, against a
 * `KNOWN_LABELS` taxonomy of 39, so the collection is one page with room for 61
 * strays before a second is even requested.
 */
function listLabelNames(): string[] {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const batch = curlJson(`${API}/labels?per_page=100&page=${page}`) as Array<{
      name: string;
    }>;
    names.push(...batch.map((l) => l.name));
    if (batch.length < 100) break;
  }
  return names;
}

function planLabelDeletions(live: readonly string[]): string[] {
  return live.filter((name) => !KNOWN_LABELS.has(name));
}

function main(): void {
  const apply = process.argv.includes("--apply");
  // Fail closed before planning anything. Not a redundant assert: the one way
  // this script turns catastrophic is a refactor that leaves the import
  // resolving to an empty or wrong set, and no type proves it didn't.
  if (!KNOWN_LABELS.has("P0") || !KNOWN_LABELS.has("design")) {
    throw new Error(
      "KNOWN_LABELS looks hollow (no P0/design) — refusing to plan deletions"
    );
  }

  const live = listLabelNames();
  const plan = planLabelDeletions(live);
  console.log(
    `live labels: ${live.length}; on-taxonomy: ${live.length - plan.length}; strays: ${plan.length}`
  );
  for (const name of plan) console.log(`  delete ${name}`);
  if (plan.length === 0) return;
  if (!apply) {
    console.log("dry run — pass --apply to delete");
    return;
  }
  if (!token) {
    console.error("--apply needs GH_TOKEN (or GITHUB_TOKEN)");
    process.exit(1);
  }

  let deleted = 0;
  let gone = 0;
  for (const name of plan) {
    const status = curlDeleteStatus(
      `${API}/labels/${encodeURIComponent(name)}`
    );
    if (status === "204") deleted++;
    // A concurrent run (two label events in one minute) got there first.
    else if (status === "404") gone++;
    else throw new Error(`deleting \`${name}\` answered ${status}`);
  }
  // 204/404 are the verification — the label LIST serves stale after a write
  // (environment.md §GitHub access), so re-reading it here would only lie.
  console.log(`deleted ${deleted}${gone ? `; already gone ${gone}` : ""}`);
}

main();
