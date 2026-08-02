// DB INTEGRATION TIER — the #1866 overdue-follow-up escalation orchestrator
// (runFollowUpNudges) against the real query layer, driven at the network seam
// (the notify-orchestrators precedent: a REAL channel — Home Assistant — with
// global fetch stubbed, so the real dispatch/marker/dedupe machinery runs).
//
// Pins the acceptance the issue names:
//   - the TICK-LEVEL two-send cadence: overdue crossing → one send; weeks later →
//     one repeat; then silence forever;
//   - the SAFETY contract: an Upcoming DISMISS (same `followup:<id>` dedupeKey)
//     never silences the send, while a live SNOOZE freezes the cadence and its
//     expiry resumes it (isHiddenUnderPolicy, snooze-only);
//   - the TERMINATOR: a declined follow-up never sends again — including after
//     re-detection (marker swept, ticks re-run, and a deliberate re-track starts a
//     NEW chain node whose fresh cadence is a fresh consent, never the old one's).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileHomeAssistant, getProfileSetting } from "@/lib/settings";
import {
  runFollowUpNudges,
  renderFollowUpNudgeMessage,
} from "@/lib/notifications/followup";
import {
  followUpNudgeMarkerKey,
  FOLLOWUP_REPEAT_DAYS,
} from "@/lib/followup-nudge";
import {
  trackImagingFollowUpCore,
  settleFollowUpCore,
} from "@/lib/followup-write";
import { followUpItems } from "@/lib/followup-findings";
import { snoozeFinding, dismissFinding } from "@/lib/queries";
import { FOLLOWUP_PREFIX } from "@/lib/followup";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-fu";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addStudy(p: number, studyDate: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO imaging_studies
           (profile_id, modality, body_region, contrast, study_date, impression)
         VALUES (?, 'ct', 'Chest', 0, ?, '6 mm RLL nodule, follow-up CT')`
      )
      .run(p, studyDate).lastInsertRowid
  );
}

// An OVERDUE tracked follow-up: study far in the past + a short interval.
function trackOverdueFollowUp(p: number, now: string): number {
  const studyId = addStudy(p, shiftDateStr(now, -400));
  const res = trackImagingFollowUpCore(p, studyId, 91, now);
  expect(res.kind).toBe("created");
  return (res as { carePlanItemId: number }).carePlanItemId;
}

function configureHA(profileId: number): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl: HA_URL,
    secret: "",
    disabledKinds: [],
  });
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runFollowUpNudges — two-send cadence at the tick level (#1866)", () => {
  it("overdue crossing → one send; weeks later → one repeat; then silence", async () => {
    const p = newProfile("FUN-cadence");
    configureHA(p);
    const now = today(p);
    const cpId = trackOverdueFollowUp(p, now);
    const fetchMock = stubFetch();

    // Crossing: the first (and only) send today, marker stamped with the date.
    expect((await runFollowUpNudges(p, "FUN", now)).failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBe(now);

    // Same day again + every day up to the repeat threshold: nothing.
    await runFollowUpNudges(p, "FUN", now);
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 1));
    await runFollowUpNudges(
      p,
      "FUN",
      shiftDateStr(now, FOLLOWUP_REPEAT_DAYS - 1)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Weeks later: exactly ONE repeat, appended to the marker.
    const repeatDay = shiftDateStr(now, FOLLOWUP_REPEAT_DAYS);
    await runFollowUpNudges(p, "FUN", repeatDay);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBe(
      `${now},${repeatDay}`
    );

    // Then nothing further, ever — however overdue it stays.
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 100));
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 400));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("no configured channel ⇒ nothing happens and no marker is burned", async () => {
    const p = newProfile("FUN-nochannel");
    const now = today(p);
    const cpId = trackOverdueFollowUp(p, now);
    const fetchMock = stubFetch();
    expect((await runFollowUpNudges(p, "FUN", now)).failed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBeUndefined();
  });
});

describe("safety contract: dismiss never silences; snooze freezes (#1866 req 4)", () => {
  it("an Upcoming dismissal on the SAME dedupeKey does not silence the send", async () => {
    const p = newProfile("FUN-dismiss");
    configureHA(p);
    const now = today(p);
    const cpId = trackOverdueFollowUp(p, now);
    // The visible finding and the send share ONE key.
    const item = followUpItems(p, now).find(
      (i) => i.followUpSettle?.carePlanItemId === cpId
    );
    expect(item?.key).toBe(`${FOLLOWUP_PREFIX}${cpId}`);
    dismissFinding(p, item!.key);

    const fetchMock = stubFetch();
    await runFollowUpNudges(p, "FUN", now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a live snooze freezes the cadence; its expiry resumes it", async () => {
    const p = newProfile("FUN-snooze");
    configureHA(p);
    const now = today(p);
    const cpId = trackOverdueFollowUp(p, now);
    snoozeFinding(p, `${FOLLOWUP_PREFIX}${cpId}`, shiftDateStr(now, 7));

    const fetchMock = stubFetch();
    await runFollowUpNudges(p, "FUN", now);
    expect(fetchMock).not.toHaveBeenCalled();
    // Frozen, not cleared: no marker was written.
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBeUndefined();

    // The snooze expires → the held first send goes out.
    const after = shiftDateStr(now, 7);
    await runFollowUpNudges(p, "FUN", after);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBe(after);
  });
});

describe("the terminator ends the escalation permanently (#1866 req 2)", () => {
  it("a declined follow-up never sends again — including after re-detection", async () => {
    const p = newProfile("FUN-decline");
    configureHA(p);
    const now = today(p);
    const studyId = addStudy(p, shiftDateStr(now, -400));
    const created = trackImagingFollowUpCore(p, studyId, 91, now);
    const cpId = (created as { carePlanItemId: number }).carePlanItemId;

    const fetchMock = stubFetch();
    await runFollowUpNudges(p, "FUN", now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Decline: "discussed, not doing it."
    const settled = settleFollowUpCore(
      p,
      cpId,
      "declined",
      now,
      "discussed with Dr. Fictional — low yield",
      now
    );
    expect(settled.kind).toBe("settled");

    // The finding is gone and the next assessment sends nothing; the stale
    // cadence marker is swept (#325).
    expect(followUpItems(p, now).some((i) => i.key.endsWith(`:${cpId}`))).toBe(
      false
    );
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBeUndefined();

    // RE-DETECTION: ticks keep re-running long past every cadence boundary —
    // the declined follow-up stays silent forever.
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, FOLLOWUP_REPEAT_DAYS));
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 200));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A DELIBERATE re-track of the same source is a NEW chain node — a new
    // tracked due date is a new consent with its own fresh cadence. The declined
    // node itself never re-enters the send set.
    const retracked = trackImagingFollowUpCore(p, studyId, 91, now);
    expect(retracked.kind).toBe("created");
    const newId = (retracked as { carePlanItemId: number }).carePlanItemId;
    expect(newId).not.toBe(cpId);
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, 201));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getProfileSetting(p, followUpNudgeMarkerKey(cpId))).toBeUndefined();
    expect(getProfileSetting(p, followUpNudgeMarkerKey(newId))).toBeDefined();
  });

  it("a done-on-date settle ends it identically", async () => {
    const p = newProfile("FUN-done");
    configureHA(p);
    const now = today(p);
    const cpId = trackOverdueFollowUp(p, now);
    const fetchMock = stubFetch();
    await runFollowUpNudges(p, "FUN", now);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const settled = settleFollowUpCore(
      p,
      cpId,
      "done",
      shiftDateStr(now, -3),
      null,
      now
    );
    expect(settled.kind).toBe("settled");
    await runFollowUpNudges(p, "FUN", shiftDateStr(now, FOLLOWUP_REPEAT_DAYS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("message rendering", () => {
  it("states the fact, the cadence framing, and a channel-neutral deep link", () => {
    const item = {
      title: "Follow-up CT chest",
      detail:
        "Overdue follow-up for the 6 mm RLL nodule (2026-03) — book it or record the result.",
      dueDate: "2026-03-15",
      reasons: [],
    };
    const first = renderFollowUpNudgeMessage(
      "Norton",
      item,
      "first",
      "https://example.test"
    );
    expect(first.kind).toBe("followup");
    expect(first.title).toContain(
      "Overdue follow-up: Norton — Follow-up CT chest"
    );
    expect(first.body).toContain("Was due 2026-03-15.");
    expect(first.body).toContain("6 mm RLL nodule");
    expect(first.actions).toEqual([
      { label: "Open Upcoming", url: "https://example.test/upcoming" },
    ]);

    const repeat = renderFollowUpNudgeMessage("Norton", item, "repeat", "");
    expect(repeat.body).toContain("Final reminder");
    // No public URL ⇒ no url action (a relative URL can't be a button).
    expect(repeat.actions).toEqual([]);
  });
});
