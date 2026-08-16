import { describe, expect, it } from "vitest";
// The verdict function is exported from the CLI script precisely so this can
// reach it without a network — the script itself only does IO when run as main.
import { assessFreshness } from "../../scripts/scheduled-run-freshness.mjs";

// Issue #2968. The weekly e2e drift census stopped being watched, and the reason
// nobody noticed is that "has it run lately" was only answerable by eye. The
// detector exists to answer it by STATE; these cover every branch of that verdict,
// because a detector whose off-nominal paths are untested is the canary again.
//
// The clock is pinned. A test that asked the real one would drift into a
// different branch as the fixture aged — which is the same class of bug the
// frozen-app-clock rule (#990) exists for, one tier down.
const NOW = Date.parse("2026-08-16T02:00:00Z");
const base = {
  workflow: "e2e-full.yml",
  state: "active",
  lastRunConclusion: "failure",
  lastRunUrl: "https://github.com/FloorLamp/allos/actions/runs/1",
  nowMs: NOW,
  maxAgeDays: 9,
};

describe("scheduled-run freshness (#2968)", () => {
  it("is silent while the schedule is still firing", () => {
    // The real 08-09 census run, judged at the moment #2968 was filed: 6.8 days
    // old, one weekly period elapsed and the next not yet due. The issue read this
    // exact history as "it stopped running"; the whole point of a state check is
    // that it does not.
    const v = assessFreshness({
      ...base,
      lastRunCreatedAt: "2026-08-09T07:27:05Z",
    });
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("fresh");
  });

  it("alarms when a whole weekly firing was skipped", () => {
    const v = assessFreshness({
      ...base,
      lastRunCreatedAt: "2026-08-02T08:40:05Z",
    });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("stale");
    expect(v.message).toMatch(/HAS NOT RUN ON ITS SCHEDULE/);
  });

  it("tolerates GitHub's scheduling slip rather than alarming on it", () => {
    // Scheduled runs land 1–2 h late routinely (the census's own history: a 06:23
    // cron observed at 07:27, 08:40, 08:41). A grace shorter than the slip would
    // make the alarm fire on healthy weeks, which is how an alarm gets ignored.
    const v = assessFreshness({
      ...base,
      lastRunCreatedAt: "2026-08-09T08:41:14Z",
    });
    expect(v.ok).toBe(true);
  });

  it("names a DISABLED workflow instead of inferring it from age", () => {
    // The mechanism by which a schedule actually goes silent — GitHub disables it
    // after 60 days of repository inactivity. A fresh timestamp would otherwise
    // report green on a workflow that will never fire again.
    const v = assessFreshness({
      ...base,
      state: "disabled_inactivity",
      lastRunCreatedAt: "2026-08-09T07:27:05Z",
    });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("disabled");
    expect(v.message).toMatch(/DISABLED_INACTIVITY/);
  });

  it("distinguishes never-fired from stale", () => {
    // Different cause, different fix: a cron that has never fired is a wrong cron
    // (or one that never reached the default branch), not a skipped run.
    const v = assessFreshness({ ...base, lastRunCreatedAt: undefined });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("absent");
    expect(v.message).toMatch(/HAS NEVER RUN/);
  });

  it("does not collapse an unparseable timestamp into stale", () => {
    // orchestrator-checkin.sh's rule, one tier over: both answers say "act", but
    // re-running the schedule cannot fix a format the reader cannot parse, so an
    // alarm that cannot tell them apart repeats after the fix and gets skipped.
    const v = assessFreshness({ ...base, lastRunCreatedAt: "last Tuesday" });
    expect(v.ok).toBe(false);
    expect(v.kind).toBe("unreadable");
    expect(v.kind).not.toBe("stale");
  });
});
