import { describe, expect, it } from "vitest";
import {
  autoReloadPlan,
  AUTO_RELOAD_MAX_ATTEMPTS,
  AUTO_RELOAD_MAX_TARGETS,
  AUTO_RELOAD_UNNAMED_TARGET,
  AUTO_RELOAD_WINDOW_MS,
  INPUT_QUIET_MS,
  nextAutoReloadGuard,
  nextSkewGuard,
  parseAutoReloadGuard,
  parseResumeMarker,
  parseUpdateTaken,
  RESUME_MARKER_MAX_AGE_MS,
  shouldAutoApplyDraft,
  showsManualUpdateNotice,
  skewRecoveryPlan,
  SKEW_RECOVERY_MAX_ATTEMPTS,
  SUBMIT_SETTLE_MS,
  UPDATE_TAKEN_MESSAGE,
  updateTakenMessage,
  type AutoReloadGuard,
  type SkewRecoveryGuard,
} from "@/lib/sw-update";

// The tab that takes the deploy itself (#2471) — the pure half.
//
// The thing under test is NOT "did a deploy happen" (that is resolveUpdateState,
// covered in sw-update.test.ts) but "may this tab throw its document away right now
// without losing a keystroke". Every case below is one way that answer can be no,
// because an automatic reload's whole licence is that the refusals are exhaustive.
//
// The end-to-end drives are e2e/stale-build-save.spec.ts (both triggers, the resume,
// the ration) and e2e/update-notice.spec.ts (the clean tab and the toast).

const T0 = 1_770_000_000_000;
const SHA = "abc1234";

/** A tab with a pending deploy and nothing at all in the way. */
const CLEAR = {
  staleBuild: false,
  pending: true,
  targetSha: SHA,
  unrecoverableWork: false,
  hidden: false,
  lastInputAt: 0,
  lastSubmitAt: 0,
  guard: null as AutoReloadGuard | null,
  now: T0,
};

describe("autoReloadPlan — when a tab may take a deploy by itself", () => {
  it("does nothing at all without a trigger", () => {
    expect(
      autoReloadPlan({ ...CLEAR, pending: false, staleBuild: false })
    ).toEqual({ action: "none" });
  });

  it("reloads a quiet tab that the detector says is behind", () => {
    expect(autoReloadPlan(CLEAR)).toEqual({ action: "reload", target: SHA });
  });

  it("reloads on a failed save alone, with the detector saying nothing", () => {
    // THE PROPERTY #2447 MAKES WORTH ASSERTING: trigger A comes from the failed save
    // itself, so recovery works in a tab whose /api/version poll has latched off and
    // will never report a deploy. `targetSha: null` is exactly that tab.
    expect(
      autoReloadPlan({
        ...CLEAR,
        pending: false,
        staleBuild: true,
        targetSha: null,
      })
    ).toEqual({ action: "reload", target: AUTO_RELOAD_UNNAMED_TARGET });
  });

  it("HOLDS for work nothing would restore — the refusal this feature rests on", () => {
    // A settings card mid-edit, a record form mid-composition: no draft covers them,
    // so a reload destroys what a manual one would not. Holding renders the old bar,
    // which is the pre-#2471 behaviour and a correct outcome.
    expect(autoReloadPlan({ ...CLEAR, unrecoverableWork: true })).toEqual({
      action: "hold",
      reason: "unrecoverable-work",
    });
  });

  it("waits — never holds — while the user is still touching the page", () => {
    // `wait` and `hold` are different answers because only `hold` may raise a bar. A
    // bar during a two-second scroll pause would be the consent gate this removes.
    expect(
      autoReloadPlan({ ...CLEAR, lastInputAt: T0 - INPUT_QUIET_MS + 1 })
    ).toEqual({ action: "wait", reason: "input" });
    expect(
      autoReloadPlan({ ...CLEAR, lastInputAt: T0 - INPUT_QUIET_MS - 1 })
    ).toEqual({ action: "reload", target: SHA });
  });

  it("reloads immediately when the tab is hidden — nobody is looking", () => {
    expect(autoReloadPlan({ ...CLEAR, hidden: true, lastInputAt: T0 })).toEqual(
      { action: "reload", target: SHA }
    );
  });

  it("waits for a submit to settle even in a hidden tab — safety outranks the fast path", () => {
    // A submit starts a write whose completion nothing here can observe, and tearing
    // the document down mid-POST is the one way this could lose a committed write.
    expect(
      autoReloadPlan({
        ...CLEAR,
        hidden: true,
        lastSubmitAt: T0 - SUBMIT_SETTLE_MS + 1,
      })
    ).toEqual({ action: "wait", reason: "submit" });
    expect(
      autoReloadPlan({
        ...CLEAR,
        hidden: true,
        lastSubmitAt: T0 - SUBMIT_SETTLE_MS - 1,
      })
    ).toEqual({ action: "reload", target: SHA });
  });

  it("treats 'never touched' as quiet, not as just-now", () => {
    // 0 is the sentinel for never, and a freshly-loaded tab nobody has touched is the
    // quietest tab there is — reading it as "input one moment ago" would strand it.
    expect(
      autoReloadPlan({ ...CLEAR, lastInputAt: 0, lastSubmitAt: 0 })
    ).toEqual({ action: "reload", target: SHA });
  });

  it("holds once the ration for this target is spent", () => {
    const guard = nextAutoReloadGuard(null, SHA, T0);
    expect(autoReloadPlan({ ...CLEAR, guard, now: T0 + 500 })).toEqual({
      action: "hold",
      reason: "ration-spent",
    });
  });

  it("gives a genuinely different build its own attempt", () => {
    // A second deploy under the same open tab is a new episode, not a retry.
    const guard = nextAutoReloadGuard(null, SHA, T0);
    expect(
      autoReloadPlan({
        ...CLEAR,
        guard,
        targetSha: "def5678",
        now: T0 + 500,
      })
    ).toEqual({ action: "reload", target: "def5678" });
  });

  it("does not ping-pong between two servers answering with different shas", () => {
    // A rolling deploy can leave /api/version answering A, then B, then A again. A
    // target-blind ration would read each flip as a fresh episode and reload forever;
    // per-target rationing caps each at one, and the ration is the LAST word only
    // because a real second deploy is genuinely a different target.
    let guard: AutoReloadGuard | null = null;
    let reloads = 0;
    for (let i = 0; i < 25; i += 1) {
      const target = i % 2 === 0 ? "aaa1111" : "bbb2222";
      const now = T0 + i * 100;
      const plan = autoReloadPlan({ ...CLEAR, targetSha: target, guard, now });
      if (plan.action === "reload") {
        reloads += 1;
        guard = nextAutoReloadGuard(guard, target, now);
      }
    }
    // One per distinct sha, capped at the window total — not one per flip.
    expect(reloads).toBe(AUTO_RELOAD_MAX_TARGETS);
  });

  it("opens a fresh window once the old one has aged out", () => {
    const guard = nextAutoReloadGuard(null, SHA, T0);
    expect(
      autoReloadPlan({
        ...CLEAR,
        guard,
        now: T0 + AUTO_RELOAD_WINDOW_MS + 1,
      })
    ).toEqual({ action: "reload", target: SHA });
  });
});

describe("showsManualUpdateNotice", () => {
  it("renders the old affordance only when the automatic path has given up", () => {
    expect(
      showsManualUpdateNotice({ action: "hold", reason: "ration-spent" })
    ).toBe(true);
    expect(
      showsManualUpdateNotice({ action: "hold", reason: "unrecoverable-work" })
    ).toBe(true);
    expect(showsManualUpdateNotice({ action: "wait", reason: "input" })).toBe(
      false
    );
    expect(showsManualUpdateNotice({ action: "reload", target: SHA })).toBe(
      false
    );
    expect(showsManualUpdateNotice({ action: "none" })).toBe(false);
  });
});

describe("the auto-reload ration", () => {
  it("ignores anything unparseable rather than throwing", () => {
    expect(parseAutoReloadGuard(null)).toBeNull();
    expect(parseAutoReloadGuard("")).toBeNull();
    expect(parseAutoReloadGuard("{")).toBeNull();
    expect(parseAutoReloadGuard("[]")).toBeNull();
    expect(parseAutoReloadGuard('{"at":1}')).toBeNull(); // no targets
    expect(parseAutoReloadGuard('{"targets":[],"at":1}')).toBeNull();
    expect(parseAutoReloadGuard('{"targets":[""],"at":1}')).toBeNull();
    expect(parseAutoReloadGuard('{"targets":[7],"at":1}')).toBeNull();
    expect(parseAutoReloadGuard('{"targets":["a"],"at":null}')).toBeNull();
    expect(parseAutoReloadGuard('{"targets":["a"],"at":7}')).toEqual({
      targets: ["a"],
      at: 7,
    });
  });

  it("counts from the window's opening, so a fast loop cannot drag it along", () => {
    const first = nextAutoReloadGuard(null, SHA, T0);
    const second = nextAutoReloadGuard(first, "def5678", T0 + 900);
    expect(second).toEqual({ targets: [SHA, "def5678"], at: T0 });
  });

  it("records the same target once, however many times it is asked", () => {
    const first = nextAutoReloadGuard(null, SHA, T0);
    expect(nextAutoReloadGuard(first, SHA, T0 + 10)).toEqual(first);
  });

  it("never reloads more than AUTO_RELOAD_MAX_ATTEMPTS times in a window", () => {
    let guard: AutoReloadGuard | null = null;
    let reloads = 0;
    // A deploy that stays broken: every pass, the tab is still behind and still quiet.
    for (let i = 0; i < 25; i += 1) {
      const now = T0 + i * 100;
      if (autoReloadPlan({ ...CLEAR, guard, now }).action === "reload") {
        reloads += 1;
        guard = nextAutoReloadGuard(guard, SHA, now);
      }
    }
    expect(reloads).toBe(AUTO_RELOAD_MAX_ATTEMPTS);
  });
});

describe("the combined worst case: a broken deploy under a dirty editor", () => {
  it("bounds the total automatic reloads by the SUM of the two rations, then stops", () => {
    // THE COMPOSITION THIS PINS. Two independent automatic reloads now exist in the
    // app — this issue's, and #1906's crash recovery — under two sessionStorage keys
    // with the same guard shape. They must not be able to refill each other into a
    // loop the user never sees. So simulate the worst case honestly: a deploy that
    // stays broken, a tab that is always quiet and always behind, and a navigation
    // that throws a chunk error on every single pass.
    let autoGuard: AutoReloadGuard | null = null;
    let crashGuard: SkewRecoveryGuard | null = null;
    let reloads = 0;
    const CHUNK = {
      name: "ChunkLoadError",
      message: "Loading chunk 42 failed",
    };

    for (let i = 0; i < 25; i += 1) {
      const now = T0 + i * 100;
      // The tab notices it is behind and tries to converge…
      if (
        autoReloadPlan({ ...CLEAR, guard: autoGuard, now }).action === "reload"
      ) {
        reloads += 1;
        autoGuard = nextAutoReloadGuard(autoGuard, SHA, now);
        continue;
      }
      // …and, still stale, its next navigation dies on a deleted chunk.
      if (
        skewRecoveryPlan({
          error: CHUNK,
          updatePending: true,
          guard: crashGuard,
          now,
        }) === "hard-reload"
      ) {
        reloads += 1;
        crashGuard = nextSkewGuard(crashGuard, now);
      }
    }

    expect(reloads).toBe(AUTO_RELOAD_MAX_ATTEMPTS + SKEW_RECOVERY_MAX_ATTEMPTS);
    // And what the user is left with is the two honest surfaces, not a spinning tab.
    expect(
      showsManualUpdateNotice(
        autoReloadPlan({ ...CLEAR, guard: autoGuard, now: T0 + 3000 })
      )
    ).toBe(true);
    expect(
      skewRecoveryPlan({
        error: CHUNK,
        updatePending: true,
        guard: crashGuard,
        now: T0 + 3000,
      })
    ).toBe("render-card");
  });
});

describe("the resume marker", () => {
  it("is a pointer and nothing else, and anything malformed is ignored", () => {
    expect(parseResumeMarker(null)).toBeNull();
    expect(parseResumeMarker("nope")).toBeNull();
    expect(parseResumeMarker("[]")).toBeNull();
    expect(
      parseResumeMarker('{"formKey":"","recordId":null,"live":false,"at":1}')
    ).toBeNull();
    expect(
      parseResumeMarker(
        '{"formKey":"activity","recordId":"7","live":false,"at":1}'
      )
    ).toBeNull();
    expect(
      parseResumeMarker(
        '{"formKey":"activity","recordId":null,"live":1,"at":1}'
      )
    ).toBeNull();
    expect(
      parseResumeMarker('{"formKey":"activity","recordId":null,"live":false}')
    ).toBeNull();
    expect(
      parseResumeMarker(
        '{"formKey":"activity","recordId":7,"live":true,"at":123}'
      )
    ).toEqual({ formKey: "activity", recordId: 7, live: true, at: 123 });
  });
});

describe("shouldAutoApplyDraft — the one argued exception to never-apply-without-a-tap", () => {
  const MARKER = {
    formKey: "activity",
    recordId: 7,
    live: false,
    at: T0 - 1000,
  };
  const OK = {
    marker: MARKER,
    formKey: "activity",
    recordId: 7 as number | null,
    savedAt: T0 - 2000,
    conflicts: false,
    now: T0,
  };

  it("applies when this mount IS the continuation", () => {
    expect(shouldAutoApplyDraft(OK)).toBe(true);
  });

  it("falls back to the offer with no marker at all — an organic revisit", () => {
    expect(shouldAutoApplyDraft({ ...OK, marker: null })).toBe(false);
  });

  it("falls back when the marker names a different form", () => {
    expect(shouldAutoApplyDraft({ ...OK, formKey: "medication" })).toBe(false);
  });

  it("falls back when the marker names a different record", () => {
    expect(shouldAutoApplyDraft({ ...OK, recordId: 8 })).toBe(false);
    expect(shouldAutoApplyDraft({ ...OK, recordId: null })).toBe(false);
  });

  it("falls back when the form on screen has already been typed into", () => {
    // Applying on top of live input is the one thing the offer banner exists to make
    // visible, and the draft read is asynchronous, so this really can happen.
    expect(shouldAutoApplyDraft({ ...OK, conflicts: true })).toBe(false);
  });

  it("falls back once the continuation has aged out", () => {
    // "The tap already happened" expires quickly. A tab the browser restored an hour
    // later is a revisit, and a revisit gets the banner.
    expect(
      shouldAutoApplyDraft({
        ...OK,
        marker: { ...MARKER, at: T0 - RESUME_MARKER_MAX_AGE_MS - 1 },
      })
    ).toBe(false);
  });

  it("falls back for a draft that is older than the continuation allows", () => {
    // Drafts live seven days; a continuation vouches for minutes. The draft's own age
    // is checked separately because a stale draft under a fresh marker is still a
    // draft the user did not just type.
    expect(
      shouldAutoApplyDraft({
        ...OK,
        savedAt: T0 - RESUME_MARKER_MAX_AGE_MS - 1,
      })
    ).toBe(false);
  });

  it("falls back on a clock that moved backwards rather than trusting it", () => {
    expect(
      shouldAutoApplyDraft({ ...OK, marker: { ...MARKER, at: T0 + 5000 } })
    ).toBe(false);
    expect(shouldAutoApplyDraft({ ...OK, savedAt: T0 + 5000 })).toBe(false);
  });
});

describe("the update-taken marker and its words", () => {
  it("ignores anything malformed", () => {
    expect(parseUpdateTaken(null)).toBeNull();
    expect(parseUpdateTaken("{")).toBeNull();
    expect(parseUpdateTaken("3")).toBeNull();
    expect(parseUpdateTaken('{"sha":7,"commitMessage":null}')).toBeNull();
    expect(parseUpdateTaken('{"sha":null,"commitMessage":7}')).toBeNull();
  });

  it("accepts a build the server never named", () => {
    // Trigger A can reload with no sha at all; the toast still has something true to
    // say, it just cannot say what shipped.
    expect(parseUpdateTaken('{"sha":null,"commitMessage":null}')).toEqual({
      sha: null,
      commitMessage: null,
    });
  });

  it("names the build when the server named one, and says less when it did not", () => {
    expect(
      updateTakenMessage({ sha: SHA, commitMessage: "Fix the thing" })
    ).toBe(`${UPDATE_TAKEN_MESSAGE} — Fix the thing`);
    expect(updateTakenMessage({ sha: SHA, commitMessage: null })).toBe(
      UPDATE_TAKEN_MESSAGE
    );
  });
});
