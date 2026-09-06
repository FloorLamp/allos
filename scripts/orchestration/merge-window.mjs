// ONE enumeration of main's merges, and ONE answer to "is this merge
// user-visible" — read from the FILES the merge touched.
//
// pm-digest.sh classified by PATH; release-notes-gather.mjs re-answered the
// same question by TITLE, with a regex list its own header called a heuristic.
// Paths are the better evidence and the digest was already computing them.
// Measured over the 63 merges reachable at 70478be5a with both classifiers run
// side by side: they disagreed on 19, and the path answer was right on all 19 —
// docs-only, spec-only and test-only merges whose titles carry none of the
// heuristic's words ("Only the owner or a red main makes a P1"). The one class
// titles caught and paths did not was the dependency bump, whose whole diff is
// the two package manifests (#4860: 290/409 package-lock.json, 1/1
// package.json) — named non-production below, so the fold loses nothing.
//
// Reads the checkout's origin/main: no token, no API budget, and the file list
// comes free with the enumeration.

import { execFileSync } from "node:child_process";

/**
 * Paths that are not production code — nothing a person using the app can see
 * change. Everything else counts, so a new production directory is included by
 * default rather than forgotten.
 */
const NON_PRODUCTION =
  /^(e2e\/|.*__tests__\/|.*\.(test|spec)\.[cm]?[jt]sx?$|docs\/|scripts\/|\.claude\/|\.github\/|lib\/release-notes\.json$|package(-lock)?\.json$|.*\.md$)/;

const RECORD = "\x01";
const FIELDS = "\x02";

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // Both renderings group by day, so the day must not depend on the reader's
    // host clock.
    env: { ...process.env, TZ: "UTC" },
  });
}

/**
 * Every commit on origin/main since `since` (a `YYYY-MM-DD` day or an ISO
 * instant), newest first, each with the files it touched and one verdict.
 *
 * `floor` is null when the checkout's history reaches back past `since`, and
 * otherwise the instant coverage really starts at. A SHALLOW clone — what every
 * agent container has — returns fewer merges rather than failing, and a clipped
 * sweep that reads as complete is the defect #5343 fixed at the gatherer's old
 * page cap. Same failure, one place, both renderings.
 */
export function mergeWindow(repoDir, since) {
  // A BARE DAY IS NOT MIDNIGHT to git: approxidate gives a date with no time
  // the CURRENT time of day, so `--since=2026-09-05` run at 14:28 means
  // 2026-09-05 14:28 and silently drops the earlier part of the day. Measured
  // 2026-09-06 on this history: 35 commits back instead of 64, cut at 14:40.
  // The gatherer passes a day (a release-notes date, inclusive), so it is
  // spelled as an instant here rather than at one caller.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since;
  const raw = git(repoDir, [
    "log",
    `--since=${from}`,
    `--format=${RECORD}%H\t%cd\t%s\t%b${FIELDS}`,
    "--date=format-local:%Y-%m-%d %H:%M",
    "--numstat",
    "origin/main",
  ]);
  const merges = [];
  for (const record of raw.split(RECORD).slice(1)) {
    const [head, stats = ""] = record.split(FIELDS);
    const [sha, date, subject, ...bodyParts] = head.split("\t");
    const files = [];
    let prod = 0;
    let all = 0;
    for (const line of stats.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      const n = (m[1] === "-" ? 0 : +m[1]) + (m[2] === "-" ? 0 : +m[2]);
      files.push(m[3]);
      all += n;
      if (!NON_PRODUCTION.test(m[3])) prod += n;
    }
    merges.push({
      sha: sha.slice(0, 9),
      date,
      day: date.slice(0, 10),
      subject: subject.replace(/\s*\(#\d+\)\s*$/, ""),
      pr: (subject.match(/\(#(\d+)\)\s*$/) || [])[1],
      issues: [
        ...(subject + "\n" + bodyParts.join("\t")).matchAll(
          /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
        ),
      ].map((m) => +m[1]),
      files,
      prod,
      all,
      // Presence, not size: a rename or a binary change reports no lines and
      // still moves production.
      userVisible: files.some((f) => !NON_PRODUCTION.test(f)),
    });
  }
  const reachesBack =
    git(repoDir, ["rev-parse", "--is-shallow-repository"]).trim() !== "true" ||
    git(repoDir, [
      "log",
      "--max-count=1",
      `--until=${from}`,
      "--format=%H",
      "origin/main",
    ]).trim() !== "";
  return { merges, floor: reachesBack ? null : (merges.at(-1)?.date ?? since) };
}
