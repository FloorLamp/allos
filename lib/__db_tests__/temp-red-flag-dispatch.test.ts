// DB INTEGRATION TIER — the #1025 event-driven temperature red-flag dispatch,
// end-to-end through the REAL write core (logTemperatureCore) and the shared
// runTempRedFlag orchestrator, with the fake-channel-at-the-fetch-seam harness
// (notify-orchestrators / prn-redose-notify precedent: a configured Home Assistant
// webhook + stubbed global fetch). Pins the issue's acceptance cases:
//   • a qualifying reading logged through the write core → the nudge send path is
//     invoked once, immediately (no day gate);
//   • a second same-episode reading under the same rule/date → the per-finding
//     marker holds (no re-nag);
//   • a NEW crossing after a clean same-day assessment still fires (the day-gate
//     failure chain this issue removes);
//   • a backfilled historical reading does not fire (latest-reading framing), and a
//     crossing value with NO open episode sends nothing;
//   • an ordinary reading never reaches the notification path (the cheap pre-check).
//
// Every value is synthetic (a fake HA webhook URL; no phones, no PHI).

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  setProfileHomeAssistant,
  setProfileSetting,
  getProfileSettingKeysWithPrefix,
  resolveSituationId,
} from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";
import { logTemperatureCore } from "@/lib/temperature-log";
import { dispatchTempRedFlagForReading } from "@/lib/notifications/temp-red-flag";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-trf";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
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

// An open illness episode started `startDaysAgo` (the temp-red-flag-findings
// fixture shape).
function makeSick(p: number, startDaysAgo: number): void {
  resolveSituationId(p, "Illness");
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(p);
  const events: SituationEvent[] = [
    {
      date: shiftDateStr(today(p), -startDaysAgo),
      situation: "Illness",
      change: "start",
    },
  ];
  setProfileSetting(
    p,
    "situation_events",
    serializeSituationEvents([], events)
  );
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(p, shiftDateStr(today(p), -startDaysAgo));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchTempRedFlagForReading (#1025)", () => {
  it("a qualifying reading through the real write core fires ONCE; a same-rule repeat holds", async () => {
    const p = newProfile("TrfDispatch");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    // The write core derives the flag; the dispatch evaluates + sends immediately.
    const outcome = logTemperatureCore(p, 104.5, "F", date, "14:00");
    expect(outcome.kind).toBe("logged");
    const r1 = await dispatchTempRedFlagForReading(
      p,
      outcome.kind === "logged" ? outcome.degF : 0
    );
    expect(r1.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The per-finding marker (keyed by the dedupeKey — reading date + rule) is set.
    expect(
      getProfileSettingKeysWithPrefix(p, "notify_last_tempredflag_")
    ).toHaveLength(1);

    // A second same-day crossing under the SAME rule → same dedupeKey → the marker
    // holds; no re-nag.
    const second = logTemperatureCore(p, 104.8, "F", date, "16:00");
    expect(second.kind).toBe("logged");
    await dispatchTempRedFlagForReading(p, 104.8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a NEW crossing after a clean same-day assessment still fires (the removed day-gate case)", async () => {
    const p = newProfile("TrfIntraDay");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    // Morning: a non-crossing reading — assessing now sends nothing (clean).
    logTemperatureCore(p, 100.6, "F", date, "08:00");
    await dispatchTempRedFlagForReading(p, 100.6);
    expect(fetchMock).not.toHaveBeenCalled();

    // 2 PM: the fever spikes past the cited line — the push goes NOW, not tomorrow.
    const spike = logTemperatureCore(p, 104.2, "F", date, "14:00");
    expect(spike.kind).toBe("logged");
    await dispatchTempRedFlagForReading(p, 104.2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an ordinary reading never reaches the notification path (cheap pre-check)", async () => {
    const p = newProfile("TrfOrdinary");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();
    logTemperatureCore(p, 99.1, "F", today(p), "09:00");
    await dispatchTempRedFlagForReading(p, 99.1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getProfileSettingKeysWithPrefix(p, "notify_last_tempredflag_")
    ).toHaveLength(0);
  });

  it("a backfilled historical reading does not fire (latest-reading framing)", async () => {
    const p = newProfile("TrfBackfill");
    makeSick(p, 3);
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    // Today's latest reading is mild; a 104.9 °F reading BACKFILLED to two days ago
    // is not the episode's latest, so the orchestrator derives no new finding.
    logTemperatureCore(p, 100.2, "F", date, "09:00");
    logTemperatureCore(p, 104.9, "F", shiftDateStr(date, -2), "21:00");
    await dispatchTempRedFlagForReading(p, 104.9);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a crossing value with NO open episode sends nothing", async () => {
    const p = newProfile("TrfNoEpisode");
    configureHA(p);
    const fetchMock = stubFetch();
    logTemperatureCore(p, 105.0, "F", today(p), "10:00");
    await dispatchTempRedFlagForReading(p, 105.0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
