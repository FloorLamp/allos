// Issue-body write — the ONE path every body PATCH in this directory takes,
// and the guard that turns a blanked body into a refusal instead of an
// incident (#5673).
//
//   npx tsx scripts/orchestration/issue-body-write.ts <issue> <body-file>           # guarded
//   npx tsx scripts/orchestration/issue-body-write.ts <issue> <body-file> --force   # write anyway
//
// Before writing it reads the CURRENT body and saves it under `$SCRATCH`
// (default /root/.local/state/allos-work), timestamped, and prints the path.
// Then it refuses an empty new body, or one shorter than half the current
// body, unless --force is passed; the refusal names both lengths. One PATCH
// from a missing file blanked #4959's body; the same write on the pinned
// Ladder issue would lose the dispatch state.
//
// Confinement (pinned in lib/__tests__/reconcile-tracker.test.ts): one PATCH
// whose payload is built from exactly one field (`body`). No state field, no
// other verb. Writes ride the named credential variables only.
//
// Exit codes: 0 written · 1 refused · 2 cannot run (usage, no token, no file).
import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_REPO } from "./reconcile-tracker-core";
import { helpGuard, isMain } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

const SCRATCH_DEFAULT = "/root/.local/state/allos-work";

export interface BodyWrite {
  repo: string;
  token: string;
  issue: number | string;
  body: string;
  /** Write even an empty or half-length body. */
  force?: boolean;
}

/** The guard said no; the current body was saved before it did. */
export class BodyWriteRefused extends Error {}

/**
 * WHAT A GITHUB JSON WRITE MUST DECLARE — the one header list every write in
 * this directory sends (#5758, #5792).
 *
 * `Content-Type` is not optional on a request that carries a body. `-d` and
 * `--data-binary` with no declared type make curl default to
 * `application/x-www-form-urlencoded`, and the write is refused with HTTP 415 —
 * "Request bodies must declare Content-Type: application/json" — before it ever
 * reaches the API. It is inert on a GET or a DELETE, which send no body, so one
 * list serves every call and no site has to decide.
 *
 * It is ONE list because it was five, and four of them were missing that header:
 * the omission spread by copying, and the next script would have copied it too.
 *
 * The list is pinned as DATA in `lib/__tests__/issue-body-write.test.ts` and at
 * each write site in the `reconcile-*-script` tests, by comparing the argv handed
 * to curl. It CANNOT be pinned by watching a live write succeed: writes from this
 * container are credentialed by the agent proxy, so a round trip returns 2xx even
 * with no `Authorization` header at all. What a live request does pin is DELIVERY,
 * and only against an issue number that cannot exist — without the header the
 * proxy answers 415 and the API never sees it; with the header GitHub answers 404.
 * The two outcomes differ in who answered, which a 2xx cannot tell you.
 */
export function githubJsonHeaders(token: string): string[] {
  return [
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "Content-Type: application/json",
  ];
}

function curlJson(args: readonly string[]): unknown {
  return JSON.parse(
    execFileSync("curl", ["-sS", "--fail-with-body", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
  );
}

/**
 * Save the current body, judge the new one, PATCH. Returns the scratch copy's
 * path; throws `BodyWriteRefused` (after saving) when the guard says no.
 */
export function writeIssueBody(write: BodyWrite): string {
  const { repo, token, issue, body } = write;
  const url = `https://api.github.com/repos/${repo}/issues/${issue}`;
  const headers = githubJsonHeaders(token);
  const current =
    (curlJson([...headers, url]) as { body: string | null }).body ?? "";
  const dir = path.join(process.env.SCRATCH || SCRATCH_DEFAULT, "issue-bodies");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const saved = path.join(dir, `${issue}-${stamp}.md`);
  fs.writeFileSync(saved, current);
  console.log(
    `issue-body-write: saved the current body of #${issue} (${current.length} chars) to ${saved}`
  );
  if (
    !write.force &&
    (body.trim() === "" || body.length * 2 < current.length)
  ) {
    throw new BodyWriteRefused(
      `issue-body-write: refusing #${issue}: the new body is ${body.length} chars, ` +
        `the current body ${current.length} — empty, or under half. The current ` +
        `body is saved at ${saved}; re-run with --force to write anyway.`
    );
  }
  curlJson([
    "-X",
    "PATCH",
    ...headers,
    "--data-binary",
    JSON.stringify({ body }),
    url,
  ]);
  return saved;
}

if (isMain(process.argv, import.meta.url)) {
  const args = process.argv.slice(2);
  const [issue, file] = args.filter((a) => !a.startsWith("--"));
  if (!issue || !file) {
    console.error("usage: issue-body-write.ts <issue> <body-file> [--force]");
    process.exit(2);
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("issue-body-write: no GH_TOKEN/GITHUB_TOKEN. Refusing.");
    process.exit(2);
  }
  // The incident's mechanism: a missing file read as an empty body.
  if (!fs.existsSync(file)) {
    console.error(`issue-body-write: body file ${file} does not exist.`);
    process.exit(2);
  }
  const body = fs.readFileSync(file, "utf8");
  try {
    writeIssueBody({
      repo: process.env.RECONCILE_REPO || DEFAULT_REPO,
      token,
      issue,
      body,
      force: args.includes("--force"),
    });
  } catch (err) {
    if (!(err instanceof BodyWriteRefused)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  console.log(`wrote #${issue} (${body.length} chars)`);
}
