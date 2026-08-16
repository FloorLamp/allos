#!/usr/bin/env node
// Alarm when a SCHEDULED workflow has stopped firing (issue #2968).
//
// The weekly e2e drift census went red three Sundays running and nobody read it —
// and while nobody was reading, the more expensive question went unasked: is it
// still running at all? Nothing could answer that, because "has it run lately"
// was only ever answerable by a person remembering to open the Actions tab. That
// is the canary failure docs/orchestration-incidents.md has now billed this repo
// for three times (the canary that couldn't, the wake that wasn't, the wake alarm
// that lied).
//
// So: detect by STATE, the shape scripts/orchestrator-checkin.sh uses for its
// durable wake. Ask the only question that matters — is this schedule still
// firing — and make every answer actionable:
//
//   disabled   -> GitHub turned it off (60 days of repo inactivity, or a human).
//                 Nothing will fire. Re-enable it.
//   absent     -> it has never fired on a schedule. The cron is wrong, or the
//                 workflow has only ever been dispatched by hand.
//   stale      -> it fired once and then stopped. Age exceeds a full period plus
//                 grace, so at least one firing was skipped.
//   unreadable -> this check lost the ability to see. NOT the same as fresh.
//   fresh      -> silent.
//
// THE PREMISE THIS WAS BUILT AGAINST WAS ITSELF A FALSE ALARM, which is the best
// argument for it. #2968 reported the census as having "stopped running — no run
// after 08-09". It had not: the issue was filed at 02:02 UTC on Sunday 08-16 and
// the cron fires at 06:23 UTC, so the next run was still four hours away and the
// history looked identical to a dead schedule. Eyeballing a run list cannot tell
// "one period has elapsed" from "one period was skipped" — you need the schedule
// and the clock, which is exactly what this does and a reader does not.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
// It does not read CONCLUSIONS. A red census is a different problem with a
// different owner (e2e-full.yml's own comment says a red becomes a flake-ledger
// item), and folding "it failed" into "it vanished" would give one alarm two
// meanings — which is how an alarm becomes ignorable.
//
// UNREADABLE IS NOT FRESH. If the API cannot be reached, or answers something
// this cannot parse, that is reported as its own failure and exits non-zero.
// Collapsing it into "fine" would rebuild the exact canary being replaced: a
// check that goes quiet precisely when it has lost the ability to see. The
// mirror-image mistake — collapsing unparseable into "stale" — is the one
// orchestrator-checkin.sh documents: both answers say "act", but the action
// differs, so an alarm that cannot tell them apart repeats after the fix and
// teaches its reader to skip it.
//
// Run FROM a frequent, activity-driven workflow (ci-main.yml, every push to
// main), never from a schedule of its own. A scheduled canary watching a schedule
// shares the failure mode it is watching for; tying it to merges means the
// detector is alive exactly while anyone cares about the answer.
//
// Usage:
//   node scripts/scheduled-run-freshness.mjs <workflow-file> --max-age-days <n>

// The verdict, as a PURE function of the two facts the API returns plus the
// clock — so every branch above is reachable from a test without a network. The
// caller does the IO and the exiting; this decides only what is true.
export function assessFreshness({
  workflow,
  state,
  lastRunCreatedAt,
  lastRunConclusion,
  lastRunUrl,
  nowMs,
  maxAgeDays,
}) {
  if (state !== "active") {
    return {
      ok: false,
      kind: "disabled",
      message:
        `*** ${workflow} IS ${String(state).toUpperCase()} — nothing will fire. ***\n` +
        `    GitHub disables a scheduled workflow after 60 days without repository ` +
        `activity (\`disabled_inactivity\`), and a human can disable one from the ` +
        `Actions tab. Re-enable it there, or delete the schedule if it is no longer ` +
        `wanted — a schedule nobody intends to run should not be a thing this check ` +
        `keeps asking about.`,
    };
  }

  if (!lastRunCreatedAt) {
    return {
      ok: false,
      kind: "absent",
      message:
        `*** ${workflow} HAS NEVER RUN ON ITS SCHEDULE. ***\n` +
        `    The workflow is active, so the cron itself is suspect — check the ` +
        `\`schedule:\` block. GitHub fires schedules only on the DEFAULT branch, so ` +
        `a cron added on a branch does nothing until it merges.`,
    };
  }

  const startedMs = new Date(lastRunCreatedAt).getTime();
  if (Number.isNaN(startedMs)) {
    return {
      ok: false,
      kind: "unreadable",
      message:
        `could not parse the last run's timestamp: '${lastRunCreatedAt}'.\n` +
        `    UNREADABLE IS NOT STALE — re-running the schedule cannot fix a format ` +
        `this cannot read.`,
    };
  }

  const ageDays = (nowMs - startedMs) / 86_400_000;
  const age = ageDays.toFixed(1);

  if (ageDays > maxAgeDays) {
    return {
      ok: false,
      kind: "stale",
      ageDays,
      message:
        `*** ${workflow} HAS NOT RUN ON ITS SCHEDULE FOR ${age} DAYS ` +
        `(limit ${maxAgeDays}). ***\n` +
        `    Last scheduled run: ${lastRunCreatedAt} (${lastRunConclusion}) ` +
        `${lastRunUrl ?? ""}\n` +
        `    At least one firing was skipped. The workflow reports itself active, so ` +
        `this is not a disable — check whether GitHub dropped the run (it does so ` +
        `under load) and dispatch one by hand to cover the gap.`,
    };
  }

  return {
    ok: true,
    kind: "fresh",
    ageDays,
    message:
      `${workflow}: last scheduled run ${age}d ago (${lastRunCreatedAt}, ` +
      `${lastRunConclusion}) — within the ${maxAgeDays}d window.`,
  };
}

// Imported by the test; only the CLI invocation does IO.
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const workflow = args.find((a) => !a.startsWith("--"));
  const maxAgeIdx = args.indexOf("--max-age-days");
  const maxAgeDays = maxAgeIdx === -1 ? NaN : Number(args[maxAgeIdx + 1]);

  if (!workflow || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    console.error(
      "usage: scheduled-run-freshness.mjs <workflow-file> --max-age-days <n>"
    );
    process.exit(2);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "FloorLamp/allos";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      `[freshness] cannot check ${workflow}: no GH_TOKEN/GITHUB_TOKEN in the ` +
        `environment. UNREADABLE IS NOT FRESH — failing rather than reporting a ` +
        `green this cannot see.`
    );
    process.exit(1);
  }

  const api = async (path) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "allos-scheduled-run-freshness",
      },
    });
    if (!res.ok)
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return res.json();
  };

  let meta;
  let runs;
  try {
    meta = await api(`/actions/workflows/${workflow}`);
    // `event=schedule` matters: this workflow is also dispatched by hand, and a
    // manual run is not evidence that the SCHEDULE fired. Reading the newest run
    // of any event would let a burst of dispatches mask a dead cron indefinitely.
    runs = await api(
      `/actions/workflows/${workflow}/runs?event=schedule&per_page=1`
    );
  } catch (err) {
    console.error(
      `[freshness] could not read ${workflow}: ${err.message}\n` +
        `            UNREADABLE IS NOT FRESH — this check failed, which is not the ` +
        `same as the census having failed. Re-run; if it persists, the API shape ` +
        `or the token's scope changed.`
    );
    process.exit(1);
  }

  const last = runs.workflow_runs?.[0];
  const verdict = assessFreshness({
    workflow,
    state: meta.state,
    lastRunCreatedAt: last?.created_at,
    lastRunConclusion: last?.conclusion,
    lastRunUrl: last?.html_url,
    nowMs: Date.now(),
    maxAgeDays,
  });

  if (verdict.ok) {
    console.log(`[freshness] ${verdict.message}`);
  } else {
    console.error(`[freshness] ${verdict.message}`);
    process.exit(1);
  }
}
