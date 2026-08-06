// Pure decisions behind the persisted notify tick log (#2209): WHICH lines the sink
// admits, what a line MEANS, and how lines fold back into the run they came from.
// No fs, no DB — the sink's file behavior is lib/__tests__/notify-log-sink.test.ts.

import { describe, it, expect } from "vitest";
import {
  admitsNotifyScope,
  classifyNotifyLine,
  filterNotifyRuns,
  groupNotifyRuns,
  notifyLogAdmits,
  NOTIFY_LOG_SCOPES,
  UNKNOWN_RUN_KEY,
  type NotifyEvent,
} from "../notify-log-format";

function ev(over: Partial<NotifyEvent> & { id: string }): NotifyEvent {
  return {
    time: "2026-08-06T07:00:00.000Z",
    level: "info",
    scope: "notify",
    runId: "run1",
    profileId: 1,
    loginId: null,
    message: "nothing due",
    ...over,
  };
}

describe("the scope filter (#2209)", () => {
  it("admits exactly the tick's own scopes", () => {
    expect(NOTIFY_LOG_SCOPES).toEqual(["notify", "notifications"]);
    expect(admitsNotifyScope("notify")).toBe(true);
    expect(admitsNotifyScope("notifications")).toBe(true);
  });

  it("rejects every other scope, including the noisiest neighbours", () => {
    // The whole point of a SCOPE filter rather than a level filter: persisting
    // every `info` in the web app is a different and much larger decision.
    for (const scope of [
      "ai",
      "medical",
      "import",
      "login",
      "telegram",
      "pull-tick",
      "strava-sync",
      "settings",
    ]) {
      expect(admitsNotifyScope(scope)).toBe(false);
    }
    expect(admitsNotifyScope(undefined)).toBe(false);
    // A near-miss must not sneak in on a prefix/substring match.
    expect(admitsNotifyScope("notify-extra")).toBe(false);
    expect(admitsNotifyScope("NOTIFY")).toBe(false);
  });

  it("keeps info and above but never debug, whatever LOG_LEVEL says", () => {
    for (const level of ["info", "warn", "error"]) {
      expect(notifyLogAdmits({ level, scope: "notify" })).toBe(true);
    }
    // `debug` is developer tracing, not the operator record — persisting it would
    // be the new chatter the issue rules out.
    expect(notifyLogAdmits({ level: "debug", scope: "notify" })).toBe(false);
    expect(notifyLogAdmits({ level: "error", scope: "ai" })).toBe(false);
  });
});

describe("what a line means (#2209)", () => {
  it("classifies the decline vocabulary the tick already emits", () => {
    // Censused from lib/notifications/** and scripts/notify.ts — this is the class
    // the issue exists for, and it is exactly the class that writes no row anywhere.
    const declines = [
      "nothing due",
      "already sent today",
      "no channels configured for profile",
      "no configured channels; nothing sent",
      "refill nudge skipped: no channel",
      "preventive nudge skipped: no channel",
      "illness-care nudge skipped: no channel",
      "pool refill nudge skipped: no managing login",
      "skipped: kind not deliverable to push",
      "skipped: kind not deliverable to email",
      "skipped: kind disabled for HA channel",
      "digest: nothing to send",
      "weekly recap: nothing to send",
      "message reconcile deferred (transient, pointer kept)",
      "message reconcile failed (pointer dropped)",
    ];
    for (const message of declines) {
      expect(
        classifyNotifyLine({ level: "info", message }),
        `${message} should read as a decline`
      ).toBe("decline");
    }
  });

  it("reads a warn-level decline as a decline, not as a failure", () => {
    // #2173's unroutable-profile signature is emitted at `warn`. It is still a
    // DECLINE — the tick decided not to send — and the declines-only filter must
    // catch it.
    expect(
      classifyNotifyLine({
        level: "warn",
        message: "no configured channels; nothing sent",
      })
    ).toBe("decline");
  });

  it("does not mistake a decline that mentions sending for a send", () => {
    // "no configured channels; nothing sent" contains "sent"; order matters.
    expect(
      classifyNotifyLine({ level: "info", message: "refill nudge sent" })
    ).toBe("send");
    expect(classifyNotifyLine({ level: "info", message: "sent" })).toBe("send");
  });

  it("lets a call site DECLARE its decision, beating the message text", () => {
    // The #2102 deferral trace declares `decision`, so it never depends on anyone
    // keeping a phrase table in sync with its wording.
    expect(
      classifyNotifyLine({
        level: "info",
        message: "digest deferral evaluated",
        decision: "declined",
      })
    ).toBe("decline");
    expect(
      classifyNotifyLine({
        level: "info",
        message: "digest deferred for sleep",
        decision: "proceeded",
      })
    ).toBe("note");
  });

  it("falls back to note, never to an error, for anything unrecognised", () => {
    expect(
      classifyNotifyLine({ level: "info", message: "messages reconciled" })
    ).toBe("note");
    expect(
      classifyNotifyLine({ level: "error", message: "digest failed" })
    ).toBe("failure");
  });
});

describe("grouping lines back into runs (#2209)", () => {
  it("groups every line of one profile's run together", () => {
    const runs = groupNotifyRuns([
      ev({ id: "a", message: "nothing due" }),
      ev({ id: "b", message: "refill nudge sent" }),
      ev({ id: "c", message: "profile evaluated" }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run1");
    expect(runs[0].profileId).toBe(1);
    expect(runs[0].counts).toEqual({
      total: 3,
      declines: 1,
      sends: 1,
      failures: 0,
    });
  });

  it("splits one run by PROFILE, because that is the row", () => {
    const runs = groupNotifyRuns([
      ev({ id: "a", profileId: 1 }),
      ev({ id: "b", profileId: 2 }),
      ev({ id: "c", profileId: null, message: "tick started" }),
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.profileId).sort()).toEqual([1, 2, null]);
  });

  it("does NOT split a run that straddles a minute boundary", () => {
    // The reason the tick stamps a run id at all: a fan-out over several profiles
    // routinely crosses a minute, and a timestamp-bucketing heuristic would report
    // one run as two.
    const runs = groupNotifyRuns([
      ev({ id: "a", time: "2026-08-06T06:59:59.900Z" }),
      ev({ id: "b", time: "2026-08-06T07:00:00.100Z" }),
      ev({ id: "c", time: "2026-08-06T07:01:12.000Z" }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].counts.total).toBe(3);
    expect(runs[0].startedAt).toBe("2026-08-06T06:59:59.900Z");
    expect(runs[0].endedAt).toBe("2026-08-06T07:01:12.000Z");
  });

  it("keeps two different runs of the same profile apart", () => {
    const runs = groupNotifyRuns([
      ev({ id: "a", runId: "run1", time: "2026-08-06T07:00:00.000Z" }),
      ev({ id: "b", runId: "run2", time: "2026-08-06T07:15:00.000Z" }),
    ]);
    expect(runs).toHaveLength(2);
    // Newest run first.
    expect(runs[0].runId).toBe("run2");
  });

  it("degrades an unknown run id to its own group rather than throwing", () => {
    const runs = groupNotifyRuns([
      ev({ id: "a", runId: "run1" }),
      ev({ id: "b", runId: null }),
      ev({ id: "c", runId: "" }),
    ]);
    expect(runs).toHaveLength(2);
    const unknown = runs.find((r) => r.key.startsWith(UNKNOWN_RUN_KEY));
    expect(unknown).toBeDefined();
    // Both un-stamped lines land in the unknown bucket — never merged into run1.
    expect(unknown?.counts.total).toBe(2);
    expect(runs.find((r) => r.runId === "run1")?.counts.total).toBe(1);
  });

  it("returns each run's lines oldest-first whatever order they arrived in", () => {
    const runs = groupNotifyRuns([
      ev({ id: "c", time: "2026-08-06T07:00:02.000Z" }),
      ev({ id: "a", time: "2026-08-06T07:00:00.000Z" }),
      ev({ id: "b", time: "2026-08-06T07:00:01.000Z" }),
    ]);
    expect(runs[0].events.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("survives an empty log", () => {
    expect(groupNotifyRuns([])).toEqual([]);
  });
});

describe("filtering runs (#2209)", () => {
  const runs = groupNotifyRuns([
    ev({ id: "a", profileId: 1, message: "nothing due" }),
    ev({ id: "b", profileId: 1, message: "messages reconciled" }),
    ev({ id: "c", profileId: 2, message: "profile evaluated" }),
    ev({ id: "d", profileId: 2, level: "warn", message: "digest tail stale" }),
  ]);

  it("keeps a QUIET run when nothing is filtered", () => {
    // The row that must never disappear: a profile the tick evaluated and had
    // nothing to say about. Absence would reproduce the ambiguity the log exists
    // to kill.
    const out = filterNotifyRuns(runs, {
      profileId: null,
      level: null,
      declinesOnly: false,
    });
    expect(out).toHaveLength(2);
    const quiet = out.find((r) => r.profileId === 2);
    expect(quiet?.counts.declines).toBe(0);
    expect(quiet?.counts.sends).toBe(0);
  });

  it("narrows to one profile", () => {
    const out = filterNotifyRuns(runs, {
      profileId: 2,
      level: null,
      declinesOnly: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0].profileId).toBe(2);
  });

  it("declines-only drops a run that declined nothing", () => {
    const out = filterNotifyRuns(runs, {
      profileId: null,
      level: null,
      declinesOnly: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].profileId).toBe(1);
    // …and narrows the surviving run to just its declines.
    expect(out[0].events.map((e) => e.id)).toEqual(["a"]);
  });

  it("filters by level within a run", () => {
    const out = filterNotifyRuns(runs, {
      profileId: null,
      level: "warn",
      declinesOnly: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0].events.map((e) => e.id)).toEqual(["d"]);
  });
});
