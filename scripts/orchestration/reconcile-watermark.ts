// Reconcile watermark — the confined writer for the ONE piece of machine
// state the reconciliation routine keeps: the previous run's stamp. It lives
// in the tracker itself, as the body of the open issue titled
// `WATERMARK_ISSUE_TITLE` (owner, 2026-08-30), because container state dies
// with the container and a lost watermark silently reshapes the sweep window.
//
//   npx tsx scripts/orchestration/reconcile-watermark.ts                # read
//   npx tsx scripts/orchestration/reconcile-watermark.ts stamp \
//     --evidence /tmp/reconcile-evidence.json [--apply]                 # from a gather
//   npx tsx scripts/orchestration/reconcile-watermark.ts stamp <iso> [--apply]
//
// The stamp records the GATHER's own `watermark.current` — never stamp-time —
// so nothing that happened between gather and stamp falls out of the next
// window. Stamping BACKWARD is refused: a stale evidence file must not rewind
// the window. Dry run by default; `--apply` writes, then re-reads the issue
// and verifies the stamp landed (§GitHub access: no write believed until
// re-read).
//
// Confinement (pinned in lib/__tests__/reconcile-tracker.test.ts): one PATCH
// whose payload is built from exactly one field (`body`), and one POST that
// can only CREATE the carrier — its title is the pinned constant — when none
// exists yet. No other verb, no state field anywhere, so this writer cannot
// close, relabel, or edit any real tracker issue.
//
// Exit codes: 0 done (or dry run printed) · 1 refused (rewind, bad ISO,
// verify failed) · 2 cannot run (no token, API trouble).

import "../load-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  DEFAULT_REPO,
  KNOWN_LABELS,
  WATERMARK_ISSUE_TITLE,
  extractWatermark,
  type TrackerIssue,
} from "./reconcile-tracker-core";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

const CARRIER_LABELS = ["infra", "parked"];
// Fail closed the way delete-unknown-labels.ts does: a refactor that renames
// these labels must break HERE, not mint strays on the live repo.
for (const label of CARRIER_LABELS) {
  if (!KNOWN_LABELS.has(label)) {
    throw new Error(`carrier label ${label} is not in KNOWN_LABELS`);
  }
}

const repo = process.env.RECONCILE_REPO || DEFAULT_REPO;
const API = `https://api.github.com/repos/${repo}`;

function curl(args: readonly string[]): { status: number; body: string } {
  const out = execFileSync("curl", ["-sS", "-w", "\n%{http_code}", ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const cut = out.lastIndexOf("\n");
  return { status: Number(out.slice(cut + 1)), body: out.slice(0, cut) };
}

function get(token: string, url: string): unknown {
  const { status, body } = curl([
    "-H",
    `Authorization: Bearer ${token}`,
    "-H",
    "Accept: application/vnd.github+json",
    url,
  ]);
  if (status < 200 || status >= 300) {
    console.error(`GET ${url} -> ${status}`);
    process.exit(2);
  }
  return JSON.parse(body);
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

function findCarrier(token: string): TrackerIssue | null {
  for (let page = 1; page <= 10; page++) {
    const batch = get(
      token,
      `${API}/issues?state=open&per_page=100&page=${page}`
    ) as GhIssue[];
    for (const i of batch) {
      if (!i.pull_request && i.title === WATERMARK_ISSUE_TITLE) {
        return {
          number: i.number,
          title: i.title,
          body: i.body ?? "",
          state: "open",
          labels: [],
        };
      }
    }
    if (batch.length < 100) break;
  }
  return null;
}

function carrierBody(iso: string): string {
  return [
    "Machine state for the tracker-reconciliation routine (#865): the",
    "previous run's watermark, read by",
    "`scripts/orchestration/reconcile-tracker.ts` and advanced only by",
    "`scripts/orchestration/reconcile-watermark.ts`. Do not edit by hand;",
    "the sweep itself never examines this issue.",
    "",
    "```json",
    JSON.stringify({ lastRunAt: iso }),
    "```",
  ].join("\n");
}

function stampOf(issue: TrackerIssue | null): string | null {
  if (!issue) return null;
  return extractWatermark([issue]).carrier.lastRunAt;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  if (args[0] !== "stamp") {
    // Read mode needs no write credential: gh-authenticated hosts (#3710)
    // can read the watermark the same way the gatherer does.
    const token = resolveReadToken(process.env);
    if (!token) {
      console.error("no GH_TOKEN/GITHUB_TOKEN and no authenticated gh");
      process.exit(2);
    }
    const carrier = findCarrier(token);
    if (!carrier) {
      console.log(`no carrier issue ("${WATERMARK_ISSUE_TITLE}") — first run`);
      return;
    }
    console.log(
      `#${carrier.number}: lastRunAt ${stampOf(carrier) ?? "(unparseable)"}`
    );
    return;
  }

  // Writes ride the named variables only — resolveReadToken's gh fallback is
  // a READ credential (environment.md §GitHub access).
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  if (!token) {
    console.error(
      "stamp needs GH_TOKEN or GITHUB_TOKEN — the gh-auth fallback is for reads."
    );
    process.exit(2);
  }

  let next: string | undefined;
  const evidenceAt = args.indexOf("--evidence");
  if (evidenceAt !== -1) {
    const file = args[evidenceAt + 1];
    if (!file || !fs.existsSync(file)) {
      console.error(
        `--evidence needs a readable file (got ${file ?? "nothing"})`
      );
      process.exit(1);
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      watermark?: { current?: string };
    };
    next = parsed.watermark?.current;
  } else {
    next = args.find((a, i) => i > 0 && !a.startsWith("--"));
  }
  if (!next || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(next)) {
    console.error(
      `stamp needs an ISO instant (got ${JSON.stringify(next ?? null)}): ` +
        "pass one, or --evidence <gather's json> to use that run's watermark.current"
    );
    process.exit(1);
  }

  const carrier = findCarrier(token);
  const current = stampOf(carrier);
  if (current && next <= current) {
    console.error(
      `refusing to rewind: carrier holds ${current}, asked to stamp ${next}. ` +
        "A stale evidence file must not shrink or rewind the next window."
    );
    process.exit(1);
  }

  if (!apply) {
    console.log(
      carrier
        ? `dry run — would stamp #${carrier.number}: ${current ?? "(none)"} → ${next}`
        : `dry run — would CREATE "${WATERMARK_ISSUE_TITLE}" ` +
            `(${CARRIER_LABELS.join(", ")}) stamped ${next}`
    );
    console.log("re-run with --apply to write");
    return;
  }

  let number: number;
  if (carrier) {
    const body = carrierBody(next);
    const { status } = curl([
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Accept: application/vnd.github+json",
      "-X",
      "PATCH",
      "-d",
      JSON.stringify({ body }),
      `${API}/issues/${carrier.number}`,
    ]);
    if (status !== 200) {
      console.error(`PATCH issue #${carrier.number} -> ${status}`);
      process.exit(2);
    }
    number = carrier.number;
  } else {
    const { status, body: reply } = curl([
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Accept: application/vnd.github+json",
      "-X",
      "POST",
      "-d",
      JSON.stringify({
        title: WATERMARK_ISSUE_TITLE,
        body: carrierBody(next),
        labels: CARRIER_LABELS,
      }),
      `${API}/issues`,
    ]);
    if (status !== 201) {
      console.error(`POST create carrier -> ${status}`);
      process.exit(2);
    }
    number = (JSON.parse(reply) as { number: number }).number;
  }

  // No write believed until re-read.
  const readBack = get(token, `${API}/issues/${number}`) as GhIssue;
  const landed = stampOf({
    number,
    title: readBack.title,
    body: readBack.body ?? "",
    state: "open",
    labels: [],
  });
  if (landed !== next) {
    console.error(
      `verify FAILED: re-read #${number} holds ${landed ?? "(none)"}, expected ${next}`
    );
    process.exit(1);
  }
  console.log(
    `stamped #${number}: ${current ?? "(none)"} → ${next} (verified)`
  );
}

main();
