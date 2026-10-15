// Which checks a change needs: the fast checks always, the browser smoke set
// only when the change reaches the maintained frontend.
//
//   node scripts/select-checks.mjs <base> <head>            one JSON line for a merge queue
//   node scripts/select-checks.mjs <base> <head> --github   `smoke=true|false` for $GITHUB_OUTPUT
//
// The JSON line: {kind: "none", verify: ["checks"] or ["checks", "smoke"], weight, reason}.
// An unreadable diff selects the smoke set rather than guessing.

import { execFileSync } from "node:child_process";

// What the browser serves. Route handlers (`app/api/`, `app/v1/`, `app/healthz/`)
// are backend; their tests run in the fast checks.
const FRONTEND = [
  /^app\/(?!api\/|v1\/|healthz\/)/,
  /^components\//,
  /^e2e\//,
  /^public\//,
  /^lib\/e2e-/,
  /^(middleware|instrumentation-client)\.ts$/,
  /^(next|postcss)\.config\.js$/,
  /^playwright\.config\.ts$/,
  /^package(-lock)?\.json$/,
];

export function touchesFrontend(paths) {
  return paths.some((p) => FRONTEND.some((re) => re.test(p)));
}

function changedPaths(base, head) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${base}...${head}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function main([base, head, mode]) {
  if (!base || !head) {
    console.error("usage: select-checks.mjs <base> <head> [--github]");
    process.exit(2);
  }
  const paths = changedPaths(base, head);
  const smoke = paths === null || touchesFrontend(paths);
  if (mode === "--github") {
    console.log(`smoke=${smoke}`);
    return;
  }
  const reason =
    paths === null
      ? "diff unreadable: smoke set too"
      : smoke
        ? "frontend changed: fast checks and the smoke set"
        : "no frontend change: fast checks only";
  console.log(
    JSON.stringify({
      kind: "none",
      verify: smoke ? ["checks", "smoke"] : ["checks"],
      weight: 2,
      reason,
    })
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
