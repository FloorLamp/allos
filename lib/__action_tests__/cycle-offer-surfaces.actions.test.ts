// SERVER-ACTION TIER — the cycle offer's NEW surfaces (issue #1892).
//
// The pure #221 pin (lib/__tests__/cycle-offer-renderers.test.ts) proves the widget and
// the sheet RENDER `cycleControlState` rather than re-deriving it. This tier proves the
// two things that pin cannot see, because they need a database and a session:
//
//   • the quick-log sheet's overlay gathers the SAME state the Cycle page resolves —
//     verbatim, not a lookalike — and is gated on the SAME `cycle` relevance bit as the
//     nav entry and the dashboard presentation, server-side, so a deep link can't reach it;
//   • a STALE tap — the surface offering a verb the state has since moved past — is
//     REFUSED with the write core's typed message, never a double-log or an invented
//     period. That is what makes putting the button on a long-lived dashboard safe;
//   • the TTC gate (#5810): the overlay reaches the three daily observation taps for a
//     profile that has DECLARED a start, and for every other profile the gathered
//     payload is the one it has always been — which is a claim only a tier with a
//     database and a settings store can make.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { loadQuickEntry } from "@/app/(app)/quick-entry-actions";
import {
  startPeriodAction,
  endPeriodAction,
  reopenPeriodAction,
} from "@/app/(app)/medical/cycles/actions";
import { getForecastSuspension, listCyclePeriods } from "@/lib/cycle-store";
import {
  cycleControlState,
  cycleOffer,
  END_PERIOD_LABEL,
  REOPEN_PERIOD_LABEL,
  START_PERIOD_LABEL,
} from "@/lib/cycle-plausibility";
import { setProfileSetting, setTtcStart } from "@/lib/settings";
import {
  logBbtAction,
  logLhTestAction,
  logMucusAction,
} from "@/app/(app)/medical/cycles/ttc-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

async function readyQuickEntry(...args: Parameters<typeof loadQuickEntry>) {
  const result = await loadQuickEntry(...args);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("quick-entry read was refused");
  return result.data;
}

// A recorded period `startAgo`..`endAgo` days before this profile's today (endAgo null =
// still open). Direct insert so a test can set up a state the guarded actions refuse to
// produce — the point of a stale-tap test is a world the surface could not have made.
function seedPeriod(
  profileId: number,
  startAgo: number,
  endAgo: number | null
): void {
  const anchor = today(profileId);
  db.prepare(
    `INSERT INTO cycles (profile_id, period_start, period_end) VALUES (?, ?, ?)`
  ).run(
    profileId,
    shiftDateStr(anchor, -startAgo),
    endAgo == null ? null : shiftDateStr(anchor, -endAgo)
  );
}

// The label the surfaces would be showing right now, straight off the shared offer.
function offeredLabel(profileId: number): string | null {
  const state = cycleControlState(
    listCyclePeriods(profileId),
    today(profileId),
    getForecastSuspension(profileId)
  );
  return cycleOffer(state)?.label ?? null;
}

// Cycle relevance without any cycle rows: female + an adult birthdate is the
// life-stage half of cycleTrackingRelevant.
function makeCycleRelevant(profileId: number): void {
  setProfileSetting(profileId, "sex", "female");
  setProfileSetting(
    profileId,
    "birthdate",
    shiftDateStr(today(profileId), -365 * 30)
  );
}

describe("the quick-log sheet's period overlay (#1892/#1506)", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Sheet Cycle Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
  });

  it("gathers the SAME control state the Cycle page resolves — no second opinion", async () => {
    makeCycleRelevant(profileId);
    seedPeriod(profileId, 4, null); // a period open since 4 days ago
    const pageState = cycleControlState(
      listCyclePeriods(profileId),
      today(profileId),
      getForecastSuspension(profileId)
    );

    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("cycle");
    if (data.form !== "cycle") return;
    // Verbatim: the object the overlay renders equals the object the page renders.
    expect(data.state).toEqual(pageState);
    expect(cycleOffer(data.state)?.label).toBe(END_PERIOD_LABEL);
  });

  it("offers the START verb to a relevant profile with NO history — the state that used to show nothing", async () => {
    makeCycleRelevant(profileId);
    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("cycle");
    if (data.form !== "cycle") return;
    expect(data.state.stateLine).toBeNull();
    expect(cycleOffer(data.state)?.label).toBe(START_PERIOD_LABEL);
  });

  it("is relevance-gated SERVER-side, so a deep link can't reach it", async () => {
    // Male, no cycle rows → cycleTrackingRelevant is false, exactly as for the nav
    // entry and the dashboard presentation. The sheet already drops the row for this
    // profile; this is the second lock, for a hand-written `?quick=log-period`.
    setProfileSetting(profileId, "sex", "male");
    setProfileSetting(
      profileId,
      "birthdate",
      shiftDateStr(today(profileId), -365 * 30)
    );
    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("unavailable");
    if (data.form !== "unavailable") return;
    expect(data.message).toMatch(/Cycle/);
  });

  it("data wins: a profile with a recorded period keeps the offer regardless of sex", async () => {
    seedPeriod(profileId, 20, 16);
    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("cycle");
    if (data.form !== "cycle") return;
    expect(cycleOffer(data.state)?.label).toBe(START_PERIOD_LABEL);
  });
});

describe("a STALE tap is refused, never double-logged (#1892)", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Stale Tap Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    makeCycleRelevant(profileId);
  });

  it("start, tapped after a period was opened elsewhere: one row, and the refusal says why", async () => {
    // The dashboard rendered "Period started today" — correctly, at the time.
    expect(offeredLabel(profileId)).toBe(START_PERIOD_LABEL);
    // The phone (or another tab) opens a period in the meantime.
    seedPeriod(profileId, 0, null);

    const result = await startPeriodAction(fd({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already open/i);
    // The write did NOT happen: still exactly the one period the phone created.
    expect(listCyclePeriods(profileId)).toHaveLength(1);
    // And the surface, once revalidated, offers the verb that is now true.
    expect(offeredLabel(profileId)).toBe(END_PERIOD_LABEL);
  });

  it("start, tapped after a period ended too recently: refused with the last end date", async () => {
    // Ended 2 days ago — inside the back-to-back window the start offer suppresses.
    seedPeriod(profileId, 6, 2);
    expect(offeredLabel(profileId)).toBe(REOPEN_PERIOD_LABEL);

    const result = await startPeriodAction(fd({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too recently/i);
    expect(result.error).toContain(shiftDateStr(today(profileId), -2));
    expect(listCyclePeriods(profileId)).toHaveLength(1);
  });

  it("end, tapped after the period was already closed elsewhere: refused, nothing rewritten", async () => {
    seedPeriod(profileId, 3, null);
    expect(offeredLabel(profileId)).toBe(END_PERIOD_LABEL);
    // Closed on the Cycle page in another tab.
    expect(await endPeriodAction(fd({}))).toEqual({ ok: true });

    const stale = await endPeriodAction(fd({}));
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error).toMatch(/No period is open/i);
    // The recorded end is untouched — a second end must never move a boundary.
    expect(listCyclePeriods(profileId)[0].period_end).toBe(today(profileId));
  });

  it("reopen, tapped after a new period was opened elsewhere: refused, never merging two cycles", async () => {
    seedPeriod(profileId, 3, 0); // just ended → the reopen is on offer
    expect(offeredLabel(profileId)).toBe(REOPEN_PERIOD_LABEL);
    seedPeriod(profileId, 0, null); // …and a fresh one is opened behind its back

    const result = await reopenPeriodAction(fd({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already open/i);
    // The ended period keeps its end date; nothing was merged.
    const ended = listCyclePeriods(profileId).find((p) => p.period_end != null);
    expect(ended?.period_end).toBe(today(profileId));
  });
});

describe("the overlay's TTC half is gated on a DECLARED start (#5810)", () => {
  let profileId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Sheet TTC Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    makeCycleRelevant(profileId);
  });

  it("sends NOTHING extra to a profile that has not declared TTC — the payload is byte-for-byte what it was", async () => {
    // THE ABSENCE TEST. No profile on prod has declared TTC, so this is the case the
    // whole feature must be invisible in — and the assertion is deliberately over the
    // WHOLE payload rather than over `data.ttc`: a deep equality against the two
    // fields this arm has always carried fails if ANY part of the gate leaks, including
    // one added later by someone who never read this comment.
    seedPeriod(profileId, 4, null);
    const data = await readyQuickEntry("cycle");
    expect(data).toEqual({
      form: "cycle",
      state: cycleControlState(
        listCyclePeriods(profileId),
        today(profileId),
        getForecastSuspension(profileId)
      ),
    });
    expect(Object.keys(data).sort()).toEqual(["form", "state"]);
  });

  it("sends today's readings once the start is declared — and no earlier day's", async () => {
    // Declared, with one observation of each kind already recorded today and an older
    // one that must NOT be mistaken for it: the controls reflect the DAY, not the
    // window they are derived from.
    setTtcStart(profileId, shiftDateStr(today(profileId), -90));
    await logLhTestAction(fd({ result: "positive" }));
    await logMucusAction(fd({ quality: "egg_white" }));
    await logBbtAction(fd({ value: "97.4", unit: "F" }));

    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("cycle");
    if (data.form !== "cycle") return;
    expect(data.ttc).toEqual({
      todayLh: "positive",
      todayMucus: "egg_white",
      todayBbtF: 97.4,
      temperatureUnit: "F",
    });
  });

  it("opens empty for a declared profile with nothing logged today, and the offer beside it is untouched", async () => {
    setTtcStart(profileId, shiftDateStr(today(profileId), -30));
    const data = await readyQuickEntry("cycle");
    expect(data.form).toBe("cycle");
    if (data.form !== "cycle") return;
    expect(data.ttc).toEqual({
      todayLh: null,
      todayMucus: null,
      todayBbtF: null,
      temperatureUnit: "F",
    });
    // The gate adds a half; it never changes the verb the row is labelled with.
    expect(cycleOffer(data.state)?.label).toBe(START_PERIOD_LABEL);
  });

  it("clearing the declaration takes the half away again", async () => {
    setTtcStart(profileId, shiftDateStr(today(profileId), -30));
    await logLhTestAction(fd({ result: "negative" }));
    const declared = await readyQuickEntry("cycle");
    expect(declared.form === "cycle" && declared.ttc).toBeTruthy();

    // Clearing stops the surfaces and leaves the recorded observations where they are
    // (ttc-actions.ts): the reading is still in the store, and the overlay stops
    // offering the taps because the DECLARATION is what the gate reads.
    setTtcStart(profileId, null);
    const cleared = await readyQuickEntry("cycle");
    expect(cleared.form).toBe("cycle");
    if (cleared.form !== "cycle") return;
    expect(cleared.ttc).toBeUndefined();
  });
});
