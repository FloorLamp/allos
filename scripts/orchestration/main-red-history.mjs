// `e2e-main` history on main, and who owns each red (#5160).
//
// WHY THIS EXISTS. On 2026-09-04 an `e2e-main` red at `c6d2b2ed` went unchased.
// Five merges later the SAME failing test — `e2e/sleep-page.spec.ts:600:7` —
// was attributed to the merge it happened to land beside, and the attribution
// carried a three-head table under it. The error was not ignoring a red: it was
// that an unexplained red silently became evidence about a LATER change.
// Sampling three heads and calling it verification is the mistake, and a run of
// heads makes it hard to make.
//
// WHAT IT WILL NOT SAY. It never says a merge INTRODUCED a failure. `e2e-main`
// debounces (a burst of merges collapses to one run at the newest head), skips
// a push with no runtime surface, and can re-shard. Those heads are UNOBSERVED,
// not green — printed as their own state, never folded into a neighbour, because
// the fold IS the defect this exists to stop. "First observed failure" is a fact
// about what ran; "introducing commit" is a claim about what changed.
//
// NOT A GATE. #5160's non-goals hold: no merge freeze, no rerun-until-green
// (a re-run is how an intermittent failure gets laundered into a pass), and no
// claim that a nearby merge caused a failure without evidence.
//
// Usage:
//   node scripts/orchestration/main-red-history.mjs [--limit 40]
//     [--since <sha>] [--repo owner/name] [--ref main]
//     [--detector e2e-main] [--no-attribution]
//
// --since <sha> opens the window at a named head, which is how you point this at
// a recorded incident. --limit bounds the window (and so the API cost, which the
// last line reports). --no-attribution skips the per-red PR reads.
//
// RECORDING A VERDICT. Post one line on the red head's own merge PR:
//
//   E2E-MAIN-VERDICT: <sha8> <why this red is, or is not, that merge's>
//
// "intermittent, cross-test, not this merge" IS a verdict — a result, not a
// dodge. What must not happen is silence. The grammar, the markdown
// normalisation and the quoted-marker rule are merge-gate-core's (#5126/#5183),
// so a verdict inside a fence or a blockquote is reported as unread rather than
// counted — nobody quotes a red into being explained.
//
// Exit: 0 nothing red in the window, or every red carries a verdict · 1 a red
//   has no verdict recorded on its merge · 2 could not read GitHub (NOT a
//   verdict — re-invoke) · 3 blocked (no token: an unauthenticated read returns
//   an empty check set, which reads as "nothing failed").

import { execFileSync } from "node:child_process";
import { helpGuard, isMain } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
import { detectorStanding, markerLines } from "./merge-gate-core.mjs";
helpGuard(process.argv, import.meta.url);

export const MARKER = "E2E-MAIN-VERDICT";

// A head the detector actually reached a pass/fail verdict on. Everything else
// is a hole in the record, and each hole says why in the reader's own words.
const OBSERVED = new Set(["red", "green"]);
const WHY_UNSEEN = {
  unobserved:
    "no run at all — the debounce collapsed this head into a later one",
  "nothing-ran": "ran nothing — no runtime surface in that push",
  cancelled: "no verdict — every shard run was cancelled",
  pending: "still running",
};
const LABEL = {
  red: "RED",
  green: "green",
  unobserved: "UNOBSERVED",
  "nothing-ran": "NOTHING RAN",
  cancelled: "NO VERDICT",
  pending: "pending",
};

/** The merge PR a squashed main commit came from, per this repo's subjects. */
export const mergePr = (subject) => /\(#(\d+)\)\s*$/.exec(subject ?? "")?.[1] ?? null;

/**
 * Classify a window of heads (oldest first) and find where its record of
 * failure opens.
 *
 * @param {{sha: string, subject: string, runs?: object[], failures?: string[]}[]} heads
 * @param {string} detector
 */
export function readHistory(heads, detector = "e2e-main") {
  const classified = heads.map((head) => {
    const standing = detectorStanding(head.runs ?? [], detector);
    return {
      sha: head.sha,
      subject: head.subject ?? "",
      kind: standing.kind,
      shards: [...new Set(standing.detected.map((run) => run.name))].sort(),
      redShards: standing.red.map((run) => run.name),
      failures: head.failures ?? [],
    };
  });
  const firstRed = classified.findIndex((head) => head.kind === "red");
  return { heads: classified, firstRed };
}

/**
 * What the run of heads can honestly say about the red at `index` — and, just
 * as load-bearing, what it cannot.
 *
 * PER FAILING TEST, not per head. A head can carry a failure that was already
 * red five merges back AND one appearing for the first time, and answering
 * "was this red here before?" once for the whole head buries whichever of the
 * two the answer did not describe. That fold is the defect #5160 exists to
 * stop, one level down: db376bfa in the recorded incident is exactly this
 * shape.
 *
 * Every unobserved head between this one and the last observed one is named,
 * because that range is the width of the answer.
 */
export function verdictFor(heads, index) {
  const head = heads[index];
  const evidence = [];
  if (!head.failures.length)
    evidence.push(
      "no failing-test annotation was readable for this head, so nothing here " +
        "can say whether it is the SAME failure as another red"
    );
  const previous = heads
    .slice(0, index)
    .reduce((found, h, i) => (OBSERVED.has(h.kind) ? i : found), -1);
  if (previous !== -1) {
    const before = heads[previous].shards.join(", ");
    const now = head.shards.join(", ");
    if (before !== now)
      evidence.push(
        `SHARD SET CHANGED since ${heads[previous].sha} (${before || "none"} ` +
          `-> ${now || "none"}) — a shard number does not name the same specs ` +
          "on both sides"
      );
  }
  const firstRedFor = (failure) =>
    heads
      .slice(0, index)
      .find((h) => h.kind === "red" && h.failures.includes(failure));
  const carried = head.failures
    .map((failure) => ({ failure, at: firstRedFor(failure) }))
    .filter((entry) => entry.at);
  const fresh = head.failures.filter((failure) => !firstRedFor(failure));
  for (const { failure, at } of carried) {
    const greens = heads
      .slice(heads.indexOf(at) + 1, index)
      .filter((h) => h.kind === "green").length;
    evidence.push(
      `already red at ${at.sha}: ${failure}` +
        (greens
          ? ` — with ${greens} observed-GREEN head(s) between, so it is ` +
            "INTERMITTENT and neither head introduced it on this evidence"
          : "")
    );
  }
  for (const failure of fresh)
    evidence.push(`first red here: ${failure}`);
  if (carried.length && !fresh.length)
    return {
      headline:
        `NOT NEW HERE — every failing test was already red at or before ` +
        `${carried[0].at.sha} (${carried[0].at.subject})`,
      evidence,
    };
  if (carried.length)
    return {
      headline:
        `PART CARRIED, PART NEW — ${carried.length} of ${head.failures.length} ` +
        `failing test(s) were already red by ${carried[0].at.sha}; the other ` +
        `${fresh.length} appear here first`,
      evidence,
    };
  if (previous === -1)
    return {
      headline:
        "FIRST FAILING HEAD IN THIS WINDOW, and nothing before it was observed " +
        "— widen the window (--limit / --since) before concluding it starts here",
      evidence,
    };
  const unseen = heads
    .slice(previous + 1, index)
    .filter((h) => !OBSERVED.has(h.kind));
  for (const hole of unseen)
    evidence.push(`${hole.sha} ${WHY_UNSEEN[hole.kind]} — ${hole.subject}`);
  return {
    headline: unseen.length
      ? `FIRST OBSERVED FAILURE, over a gap — ${unseen.length} head(s) between ` +
        `it and ${heads[previous].sha} were never observed, so whatever broke ` +
        "this is anywhere in that range, not necessarily this merge"
      : `FIRST OBSERVED FAILURE — the head before it (${heads[previous].sha}) ` +
        "ran and was green, which bounds the range to this merge. It does not " +
        "prove this merge: a red here can be intermittent",
    evidence,
  };
}

/** The report, as lines. `attribution` maps sha -> the verdict note or null. */
export function renderHistory({ heads, firstRed }, attribution = new Map()) {
  const out = [];
  if (firstRed === -1)
    return [
      `No RED head in this window of ${heads.length} (oldest ${heads[0]?.sha ?? "none"}).`,
      "That is not a claim that main is green: check the UNOBSERVED and",
      "NOTHING RAN heads below before treating the window as covered.",
      "",
      ...heads.map(row),
    ];
  out.push(
    `First failing head in this window: ${heads[firstRed].sha} — and every head after it.`,
    ...(firstRed === 0
      ? [
          "THE WINDOW OPENS ON A FAILING HEAD: an older red may precede it.",
          "Widen with --limit before calling this the first.",
        ]
      : []),
    ""
  );
  out.push(...heads.slice(firstRed).map(row), "");
  for (let i = firstRed; i < heads.length; i++) {
    if (heads[i].kind !== "red") continue;
    const head = heads[i];
    const pr = mergePr(head.subject);
    const { headline, evidence } = verdictFor(heads, i);
    out.push(`${head.sha}  RED  ${pr ? `merged by #${pr}` : "no merge PR in the subject"}`);
    for (const failure of head.failures) out.push(`    failing  ${failure}`);
    out.push(`    reading  ${headline}`);
    for (const line of evidence) out.push(`    note     ${line}`);
    out.push(...attributionLines(head, pr, attribution).map((l) => `    ${l}`), "");
  }
  return out;
}

const row = (head) =>
  `  ${head.sha}  ${LABEL[head.kind].padEnd(11)}  ` +
  `${(head.kind === "red" ? head.redShards.join(", ") : shardNote(head)).padEnd(22)}  ` +
  head.subject;

const shardNote = (head) =>
  OBSERVED.has(head.kind)
    ? `${head.shards.length} shard(s)`
    : WHY_UNSEEN[head.kind].split(" — ")[0];

function attributionLines(head, pr, attribution) {
  if (!attribution.has(head.sha))
    return ["owner    not looked up (--no-attribution)"];
  const note = attribution.get(head.sha);
  if (note?.verdict)
    return [
      `verdict  ${note.verdict.who}: "${note.verdict.line}"`,
      ...(note.unread ? [`note     ${note.unread}`] : []),
    ];
  return [
    `verdict  UNEXAMINED — no ${MARKER} names ${head.sha}` +
      (pr ? ` on #${pr}` : ""),
    ...(note?.unread ? [`note     ${note.unread}`] : []),
    `record   ${MARKER}: ${head.sha} <why this red is, or is not, ${pr ? `#${pr}` : "that merge"}'s>`,
  ];
}

/**
 * Does a note set carry a verdict for this head? The marker must NAME the sha,
 * exactly as a falsifying pass must name the head it ran on — a verdict about
 * some other red is not a verdict about this one.
 */
export function verdictNote(notes, sha) {
  const { found, ignored } = markerLines(notes, MARKER);
  const names = (mark) =>
    [...mark.rest.matchAll(/[0-9a-f]{8,40}/g)].some(
      (m) => sha.startsWith(m[0]) || m[0].startsWith(sha)
    );
  return {
    verdict: found.find(names) ?? null,
    unread: ignored.length
      ? `${ignored.length} ${MARKER} line(s) here QUOTE rather than speak ` +
        "(fenced, indented or blockquoted) and were NOT read (#5183)"
      : null,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

// curl, not fetch: node's fetch ignores HTTP(S)_PROXY and the managed
// environments route GitHub through an agent proxy (ci-watch.mjs says why).
function reader(token) {
  let reads = 0;
  const get = (pathname) => {
    reads++;
    const out = execFileSync(
      "curl",
      [
        "-sS",
        "-w",
        "\n%{http_code}",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    const cut = out.lastIndexOf("\n");
    const status = Number(out.slice(cut + 1));
    if (status >= 200 && status < 300) return JSON.parse(out.slice(0, cut));
    console.error(
      `GET ${pathname} -> ${status} — cannot read history right now. NOT a verdict; re-invoke.`
    );
    process.exit(2);
  };
  return { get, count: () => reads };
}

function main(argv) {
  const token = resolveReadToken();
  if (!token) {
    console.error(
      "BLOCKED: no GH_TOKEN/GITHUB_TOKEN and no authenticated gh. Refusing to\n" +
        "read — an unauthenticated read returns an empty check set, which reads\n" +
        "as 'nothing failed' (recovery.md §Lost credentials)."
    );
    process.exit(3);
  }
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const repo = flag("--repo", "FloorLamp/allos");
  const ref = flag("--ref", "main");
  const detector = flag("--detector", "e2e-main");
  const since = flag("--since", null);
  const limit = Math.min(Number(flag("--limit", since ? "100" : "40")), 100);
  const { get, count } = reader(token);

  const commits = get(`repos/${repo}/commits?sha=${ref}&per_page=${limit}`);
  let window = commits.map((c) => ({ sha: c.sha, subject: c.commit.message.split("\n")[0] }));
  if (since) {
    const at = window.findIndex((c) => c.sha.startsWith(since));
    if (at === -1) {
      console.error(
        `${since} is not in the newest ${window.length} commits on ${ref} — raise --limit.`
      );
      process.exit(2);
    }
    window = window.slice(0, at + 1);
  }
  window.reverse();

  for (const head of window) {
    const runs = get(`repos/${repo}/commits/${head.sha}/check-runs?per_page=100`).check_runs ?? [];
    head.runs = runs;
    head.failures = [
      ...new Set(
        detectorStanding(runs, detector)
          .red.flatMap((run) => get(`repos/${repo}/check-runs/${run.id}/annotations`))
          // The Playwright reporter writes the failing test's full title on the
          // annotation that points at the spec; the job-level ones carry only
          // "Process completed with exit code 1", which names nothing.
          .filter((a) => a.annotation_level === "failure" && a.title)
          .map((a) => a.title)
      ),
    ];
  }

  const history = readHistory(window, detector);
  const attribution = new Map();
  if (!argv.includes("--no-attribution")) {
    for (const head of history.heads) {
      if (head.kind !== "red") continue;
      const pr = mergePr(head.subject);
      if (!pr) {
        attribution.set(head.sha, { verdict: null, unread: null });
        continue;
      }
      // A review and a PR comment are two different endpoints, and a verdict
      // may be written in either — merge-gate reads both for the same reason.
      const notes = [
        ...[get(`repos/${repo}/issues/${pr}`)].map((i) => ({
          body: i.body ?? "",
          at: i.created_at ?? "",
          user: i.user?.login,
        })),
        ...get(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({
          body: c.body ?? "",
          at: c.created_at ?? "",
          user: c.user?.login,
        })),
        ...get(`repos/${repo}/pulls/${pr}/reviews?per_page=100`).map((r) => ({
          body: r.body ?? "",
          at: r.submitted_at ?? "",
          user: r.user?.login,
        })),
      ];
      attribution.set(head.sha, verdictNote(notes, head.sha));
    }
  }

  console.log(renderHistory(history, attribution).join("\n"));
  const unexamined = history.heads.filter(
    (h) => h.kind === "red" && !attribution.get(h.sha)?.verdict
  );
  console.log(
    `Read ${count()} GitHub responses for ${window.length} head(s) on ${ref}.`
  );
  if (!unexamined.length) return;
  console.log(
    `${unexamined.length} red head(s) carry no verdict: ` +
      `${unexamined.map((h) => h.sha).join(", ")}. A verdict is a result, not a ` +
      "re-run — post one per head with the line above."
  );
  process.exit(1);
}

if (isMain(process.argv, import.meta.url)) main(process.argv.slice(2));
