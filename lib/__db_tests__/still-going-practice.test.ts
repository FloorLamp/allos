// DB INTEGRATION TIER — the practice kind's "Still going?" nudge (#5142 AC 3).
//
// The nudge is one family across every open episode, and this is the kind that gained
// it. What is worth pinning here is the NUMBER and the one-shot, because those are the
// two ways a suggest goes wrong: too early it interrupts someone mid-sauna, and
// repeated it becomes the thing people mute.
//
// Every value is synthetic; the Telegram transport is stubbed at the four primitives.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { setTimezone, setSetting, getProfileSetting } from "@/lib/settings";
import { seedLoginTelegram } from "./fixtures";
import { sendMessageRaw, stubTelegramSends } from "./telegram-spies";
import {
  startLivePracticeSession,
  logPracticeSession,
  getPracticeSessions,
  closeAbandonedPracticeSessions,
  stalePracticeSessions,
} from "@/lib/queries";
import {
  runStillGoingSuggest,
  stillGoingEpisodes,
  stillGoingMarkerKey,
} from "@/lib/notifications/still-going";
import { EPISODE_BOUNDS } from "@/lib/open-episode";

const START = new Date("2026-09-04T09:00:00Z");

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A live Sauna with NO usual duration, which is the only shape that ever reaches this
// nudge: a practice whose history states a length stamps its own expected end at Start
// and completes itself there (#5091), long before any bound.
function startSauna(profileId: number): number {
  vi.setSystemTime(START);
  const started = startLivePracticeSession(profileId, "Sauna", "page");
  expect(started.kind).toBe("started");
  return started.kind === "started" ? started.session.id : -1;
}

function at(quietMin: number): void {
  vi.setSystemTime(new Date(START.getTime() + quietMin * 60_000));
}

describe("the practice kind's stale window (#5142 AC 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stubTelegramSends();
    setSetting("telegram_bot_token", "test-bot-token");
  });
  afterEach(() => vi.useRealTimers());

  // THE NUMBER. Ninety minutes is past every practice this app is a logger for, and
  // one minute short of it is still someone's long sauna.
  it("asks nothing at 89 minutes of quiet and asks once at 90", () => {
    const pid = newProfile("still-going-edge");
    const id = startSauna(pid);
    // Spelled out rather than read from the table, because the NUMBER is the claim.
    expect(EPISODE_BOUNDS.practice.staleMin).toBe(90);

    at(89);
    expect(stillGoingEpisodes(pid, new Date())).toEqual([]);

    at(90);
    expect(stillGoingEpisodes(pid, new Date())).toEqual([
      { kind: "practice", rowId: id, label: "Sauna", quietMin: 90 },
    ]);
  });

  // STALE IS OPEN, ALL THE WAY TO THE ABANDON BOUND. The window has width now, and
  // this is what that width is for: the person who reads the nudge two hours later
  // still has a live row to finish.
  it("stays askable until the abandon bound, and stops being askable past it", () => {
    const pid = newProfile("still-going-width");
    startSauna(pid);

    at(EPISODE_BOUNDS.practice.abandonMin);
    expect(stillGoingEpisodes(pid, new Date())).toHaveLength(1);

    at(EPISODE_BOUNDS.practice.abandonMin + 1);
    expect(stillGoingEpisodes(pid, new Date())).toEqual([]);
    expect(stalePracticeSessions(pid, new Date())).toEqual([]);
  });

  // A ROW THAT KNOWS ITS OWN END NEVER REACHES THE NUDGE. Two logged sessions make a
  // usual duration, Start stamps it, and the episode is FINISHED at start + that
  // duration — read before any bound (#5091).
  it("never asks about a practice whose history already stated its length", () => {
    const pid = newProfile("still-going-usual");
    for (const date of ["2026-09-02", "2026-09-03"])
      logPracticeSession(pid, "Rowing", date, "page", { durationMin: 15 });
    vi.setSystemTime(START);
    expect(startLivePracticeSession(pid, "Rowing", "page").kind).toBe(
      "started"
    );

    at(EPISODE_BOUNDS.practice.staleMin);
    expect(stillGoingEpisodes(pid, new Date())).toEqual([]);
  });

  // ONE GENTLE SUGGEST (#560). The marker is burned on delivery and keyed by row id,
  // so the hourly tick asking again four hours later sends nothing.
  it("sends once and never again for the same row", async () => {
    const pid = newProfile("still-going-once");
    seedLoginTelegram(pid, "9001");
    const id = startSauna(pid);
    sendMessageRaw.mockClear();

    at(89);
    expect((await runStillGoingSuggest(pid, "Ada")).failed).toBe(false);
    expect(sendMessageRaw).toHaveBeenCalledTimes(0);
    expect(
      getProfileSetting(pid, stillGoingMarkerKey("practice", id)) ?? null
    ).toBe(null);

    at(90);
    expect((await runStillGoingSuggest(pid, "Ada")).failed).toBe(false);
    expect(sendMessageRaw).toHaveBeenCalledTimes(1);
    expect(getProfileSetting(pid, stillGoingMarkerKey("practice", id))).toBe(
      "2026-09-04"
    );
    // The message a person actually reads: the practice by name, and the two buttons
    // bound to this row.
    const [, sent] = sendMessageRaw.mock.calls[0];
    expect(sent.title).toContain("Still doing Sauna?");
    expect(sent.actions?.map((a) => a.data)).toContain(
      `sgfinish:practice:${pid}:${id}`
    );
    expect(sent.actions?.map((a) => a.data)).toContain(
      `sgdiscard:practice:${pid}:${id}`
    );

    // Two more hourly ticks inside the same still-open window send nothing more.
    at(150);
    await runStillGoingSuggest(pid, "Ada");
    at(200);
    await runStillGoingSuggest(pid, "Ada");
    expect(sendMessageRaw).toHaveBeenCalledTimes(1);
  });

  // THE SUGGEST NEVER ENDS ANYTHING (#560). Asking is not closing: after the send the
  // row is exactly as it was, live and with no end on it.
  it("leaves the row untouched — asking is not closing", async () => {
    const pid = newProfile("still-going-suggest-only");
    seedLoginTelegram(pid, "9002");
    startSauna(pid);

    at(EPISODE_BOUNDS.practice.staleMin);
    await runStillGoingSuggest(pid, "Ada");
    expect(closeAbandonedPracticeSessions(pid)).toBe(0);
    expect(getPracticeSessions(pid, "Sauna")[0]).toMatchObject({
      live: 1,
      end_time: null,
      duration_min: null,
    });
  });
});
