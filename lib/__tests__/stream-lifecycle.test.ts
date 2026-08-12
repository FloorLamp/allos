import { describe, it, expect } from "vitest";
import {
  STREAM_APPEARED_WITHIN_DAYS,
  STREAM_ENDED_AFTER_DAYS,
  STREAM_OFFBOARD_PREFIX,
  STREAM_ONBOARD_PREFIX,
  streamLifecycleState,
  streamOffboardBody,
  streamOffboardKey,
  streamOffboardTitle,
  streamOfferKind,
  streamOfferTarget,
  streamOnboardBody,
  streamOnboardKey,
  streamOnboardTitle,
  streamReminderPausedNote,
  type StreamLifecycleFacts,
  type StreamOfferSignals,
} from "@/lib/integrations/stream-lifecycle";
import { allContinuousStreams } from "@/lib/integrations/continuous-streams";
import { isStreamActive } from "@/lib/stream-activity";
import { shiftDateStr } from "@/lib/date";

// The #2162 on/offboarding state machine — pure tier: no DB, no clock, no network.
//
// Every fixture below is expressed as DAYS the stream delivered, relative to a fixed
// "today", and the expected-active gate is computed by calling the SHARED predicate
// (`isStreamActive`) over the SHARED declared window rather than by hand-setting a
// boolean. That is deliberate: the point of the issue is that this machine joins
// #2146/#2097's vocabulary instead of growing a second staleness rule, and a test that
// stubbed the gate would pass just as happily against a private copy of it.

const TODAY = "2026-08-08";
const HC = allContinuousStreams()[0];

function facts(
  deliveredDays: string[],
  extra: Partial<StreamLifecycleFacts> = {}
): StreamLifecycleFacts {
  const sorted = [...deliveredDays].sort();
  return {
    firstDay: sorted[0] ?? null,
    lastDay: sorted[sorted.length - 1] ?? null,
    expectedActive: isStreamActive(
      sorted,
      TODAY,
      HC.stream.expectedActive.windowDays,
      HC.stream.expectedActive.minDays
    ),
    today: TODAY,
    ...extra,
  };
}

/** The days from `fromBack` days ago through `toBack` days ago, inclusive. */
function days(fromBack: number, toBack: number): string[] {
  const out: string[] = [];
  for (let b = fromBack; b >= toBack; b--) out.push(shiftDateStr(TODAY, -b));
  return out;
}

describe("streamLifecycleState — the lifecycle, derived at read time", () => {
  it("a stream that has never delivered is absent, not lapsed", () => {
    expect(streamLifecycleState(facts([]))).toBe("absent");
  });

  it("its very FIRST day reads as appeared, not lapsed", () => {
    // The trap the guard order exists for: isStreamActive never inspects today and
    // needs minDays of history, so an infant stream fails the gate for structural
    // reasons. Reading that as "lapsed" would greet a brand-new wearable with the
    // offboarding prompt.
    const f = facts([TODAY]);
    expect(f.expectedActive).toBe(false);
    expect(streamLifecycleState(f)).toBe("appeared");
  });

  it("a few days in and still delivering, it is appeared", () => {
    expect(streamLifecycleState(facts(days(3, 0)))).toBe("appeared");
  });

  it("past the appeared window, a delivering stream is active", () => {
    const f = facts(days(STREAM_APPEARED_WITHIN_DAYS + 6, 0));
    expect(f.expectedActive).toBe(true);
    expect(streamLifecycleState(f)).toBe("active");
  });

  it("stopping yesterday is still active — the declared 2-of-3 window tolerates it", () => {
    expect(streamLifecycleState(facts(days(30, 1)))).toBe("active");
    expect(streamLifecycleState(facts(days(30, 2)))).toBe("active");
  });

  it("three days of silence trips the SHARED gate into lapsed", () => {
    const f = facts(days(30, 3));
    expect(f.expectedActive).toBe(false);
    expect(streamLifecycleState(f)).toBe("lapsed");
  });

  it("a lapse sustained past the horizon is ended", () => {
    expect(
      streamLifecycleState(facts(days(60, STREAM_ENDED_AFTER_DAYS - 1)))
    ).toBe("lapsed");
    expect(streamLifecycleState(facts(days(60, STREAM_ENDED_AFTER_DAYS)))).toBe(
      "ended"
    );
  });

  it("a young stream that died is ended too, not stuck at appeared", () => {
    // Delivered for two days, a month ago, and never again. The horizon outranks the
    // appeared window on purpose — otherwise it would keep offering onboarding for a
    // device that is long gone.
    expect(streamLifecycleState(facts(days(31, 30)))).toBe("ended");
  });

  it("data arriving TODAY reopens it to active from any lapse — resume needs no ceremony", () => {
    // The one day isStreamActive omits by design, which is exactly the day a resume
    // shows up on. Nothing was written when the stream lapsed, so nothing has to be
    // unwritten now.
    const resumed = facts([...days(60, 40), TODAY]);
    expect(resumed.expectedActive).toBe(false);
    expect(streamLifecycleState(resumed)).toBe("active");
  });

  it("an unreadable day is absent rather than a thrown error", () => {
    expect(
      streamLifecycleState({
        firstDay: "not-a-day",
        lastDay: "not-a-day",
        expectedActive: false,
        today: TODAY,
      })
    ).toBe("absent");
  });

  it("the ended horizon clears every registered stream's expected-active window", () => {
    // The issue's own sizing rule: the prompt must never race the gate. If a stream
    // ever declares a slow window, this fails rather than letting the offboarding
    // prompt arrive while the reminders are still firing.
    for (const s of allContinuousStreams()) {
      expect(
        STREAM_ENDED_AFTER_DAYS,
        `${s.sourceId}:${s.stream.id} expected-active window`
      ).toBeGreaterThan(s.stream.expectedActive.windowDays * 3);
    }
  });
});

describe("streamOfferKind — what is offered, and what ignoring it does", () => {
  const base: StreamOfferSignals = {
    state: "appeared",
    hasReminder: true,
    reminderEnabled: false,
    onboardDismissed: false,
    offboardDismissed: false,
  };

  it("offers onboarding exactly on appeared, with the setting off", () => {
    expect(streamOfferKind(base)).toBe("onboard");
    for (const state of ["absent", "active", "lapsed"] as const)
      expect(streamOfferKind({ ...base, state })).toBeNull();
  });

  it("offers nothing for a stream with no reminder adapter", () => {
    // The lifecycle still RESOLVES for such a stream — that is what makes a future
    // adapter a registry declaration rather than a code change here.
    expect(streamOfferKind({ ...base, hasReminder: false })).toBeNull();
    expect(
      streamOfferKind({ ...base, state: "ended", hasReminder: false })
    ).toBeNull();
  });

  it("multi-provider: an already-enabled setting is never re-offered", () => {
    // Constraint 6. The setting is profile-scoped and there is one of it, so HR via a
    // second wearable finds the consent already given and asks nothing.
    expect(streamOfferKind({ ...base, reminderEnabled: true })).toBeNull();
  });

  it("a dismissed onboarding offer stays dismissed", () => {
    expect(streamOfferKind({ ...base, onboardDismissed: true })).toBeNull();
  });

  it("offers offboarding only past the horizon, and only while the setting is ON", () => {
    const ended = { ...base, state: "ended" as const, reminderEnabled: true };
    expect(streamOfferKind(ended)).toBe("offboard");
    // Nothing paused itself for someone who never turned it on, so there is nothing
    // to explain and nothing to keep.
    expect(streamOfferKind({ ...ended, reminderEnabled: false })).toBeNull();
    // A lapse INSIDE the horizon is silent: the gate has already stopped the sends and
    // the prompt must not race it.
    expect(streamOfferKind({ ...ended, state: "lapsed" })).toBeNull();
  });

  it("a resume mid-horizon cancels the pending offboarding offer", () => {
    // Not by clearing anything — by the state no longer being `ended`. There is no
    // pending record to cancel, which is the whole reason a resume needs no ceremony.
    const ended = { ...base, state: "ended" as const, reminderEnabled: true };
    expect(streamOfferKind(ended)).toBe("offboard");
    expect(streamOfferKind({ ...ended, state: "active" })).toBeNull();
  });

  it("a dismissed offboarding prompt stays dismissed inside its episode", () => {
    expect(
      streamOfferKind({
        ...base,
        state: "ended",
        reminderEnabled: true,
        offboardDismissed: true,
      })
    ).toBeNull();
  });
});

describe("the dismissal keys — the two one-shot semantics", () => {
  it("the onboarding key is per (provider, stream) and carries no date", () => {
    const key = streamOnboardKey("health-connect", "heart-rate");
    expect(key).toBe(`${STREAM_ONBOARD_PREFIX}health-connect:heart-rate`);
    // A different source is a different offer.
    expect(streamOnboardKey("oura" as never, "heart-rate")).not.toBe(key);
  });

  it("the offboarding key is anchored on the lapse EPISODE", () => {
    const first = streamOffboardKey(
      "health-connect",
      "heart-rate",
      "2026-07-20"
    );
    expect(first).toBe(
      `${STREAM_OFFBOARD_PREFIX}health-connect:heart-rate:2026-07-20`
    );
    // A resume moves the last delivered day, so the NEXT lapse is a new key and
    // arrives un-silenced.
    expect(
      streamOffboardKey("health-connect", "heart-rate", "2026-09-02")
    ).not.toBe(first);
  });

  it("streamOfferTarget round-trips both, and refuses a foreign key", () => {
    expect(
      streamOfferTarget(streamOnboardKey("health-connect", "heart-rate"))
    ).toEqual({
      kind: "onboard",
      sourceId: "health-connect",
      streamId: "heart-rate",
    });
    expect(
      streamOfferTarget(
        streamOffboardKey("health-connect", "heart-rate", "2026-07-20")
      )
    ).toEqual({
      kind: "offboard",
      sourceId: "health-connect",
      streamId: "heart-rate",
    });
    expect(streamOfferTarget("right-size:12")).toBeNull();
    expect(streamOfferTarget(STREAM_ONBOARD_PREFIX)).toBeNull();
    expect(
      streamOfferTarget(`${STREAM_ONBOARD_PREFIX}health-connect`)
    ).toBeNull();
  });
});

describe("the copy — states the data, never the person (#2097's rule)", () => {
  const guesses = [
    /you stopped/i,
    /you haven't been wearing/i,
    /forgot/i,
    /put (it|your watch) on/i,
  ];

  it("names the provider and the stream, and instructs nobody", () => {
    const title = streamOnboardTitle("Health Connect", "heart-rate");
    const body = streamOnboardBody("heart-rate");
    expect(title).toContain("Health Connect");
    expect(title).toContain("heart-rate");
    expect(body).toContain("Off unless you turn it on");
    for (const g of guesses) {
      expect(title).not.toMatch(g);
      expect(body).not.toMatch(g);
    }
  });

  it("the offboarding copy reports the DATA gap and promises no rewrite", () => {
    const body = streamOffboardBody("Health Connect", "heart-rate", 14);
    expect(streamOffboardTitle()).toContain("paused themselves");
    expect(body).toContain("No heart-rate data has arrived");
    expect(body).toContain("14 days");
    // It says the setting is untouched, because it is: only a tap writes that field.
    expect(body).toContain("nothing here has changed your setting");
    for (const g of guesses) expect(body).not.toMatch(g);
  });

  it("the settings note discloses the pause and pluralizes honestly", () => {
    expect(
      streamReminderPausedNote("Health Connect", "heart-rate", 1)
    ).toContain("for 1 day.");
    const many = streamReminderPausedNote("Health Connect", "heart-rate", 9);
    expect(many).toContain("for 9 days.");
    expect(many).toContain("resumes on its own");
  });
});
