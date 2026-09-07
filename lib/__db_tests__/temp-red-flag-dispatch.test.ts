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
import {
  dispatchTempRedFlagForEpisodeOpen,
  dispatchTempRedFlagForReading,
} from "@/lib/notifications/temp-red-flag";
import {
  getActiveSituations,
  setActiveSituations,
} from "@/lib/settings/profile-attrs";

// The clock is FROZEN for the whole tier (#4509), late on its own UTC day, so every
// wall time this file states has already happened and `logTemperatureCore` judges it
// against a fixed instant rather than against lunchtime. The per-file pin this used to
// carry is retired with the rest of them; the profiles here are UTC.

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-trf";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function configureHA(profileId: number, webhookUrl: string = HA_URL): void {
  setProfileHomeAssistant(profileId, {
    enabled: true,
    webhookUrl,
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
    `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(p, shiftDateStr(today(p), -startDaysAgo));
}

// Open the built-in Illness situation the way the front door does: through
// `setActiveSituations`, which composes `syncOpenIllnessEpisode` inside its own write
// transaction. Deliberately NOT `makeSick` above — that one inserts the episode row by
// hand, which is fine for fixtures about an episode that already exists, and useless
// for a test about the act of OPENING one.
function openIllness(profileId: number): void {
  resolveSituationId(profileId, "Illness");
  const active = new Set(getActiveSituations(profileId));
  active.add("Illness");
  setActiveSituations(profileId, [...active]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The COPY the nudge actually goes out with. The rendered title/body is only
// observable at the transport seam, which is why it is pinned here rather than in the
// pure tier: `renderTempRedFlagMessage` builds the title, but the "[Name] " attribution
// prefix is composed one layer up, inside `dispatch`. A doubled name is a defect only
// the two together can produce, and only a real send can show.
function sentTitle(mock: ReturnType<typeof vi.fn>, call = 0): string {
  const body = mock.mock.calls[call]?.[1]?.body;
  return JSON.parse(String(body)).title as string;
}
function sentBody(mock: ReturnType<typeof vi.fn>, call = 0): string {
  const body = mock.mock.calls[call]?.[1]?.body;
  return JSON.parse(String(body)).body as string;
}

describe("the nudge's copy", () => {
  it("names the profile ONCE on a household instance, and says the reading once", async () => {
    // Two profiles ⇒ the attribution prefix applies. Before, the title read
    // "[Dune] 🌡️ Fever check: Dune — Temperature 40.3 °C / 104.5 °F — Very high
    // fever (104°F or higher)": the name twice, "fever" three times, the threshold
    // three times, the reading twice.
    newProfile("Ferrus");
    const p = newProfile("Dune");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();

    logTemperatureCore(p, 104.5, "F", today(p), "page", "14:00");
    await dispatchTempRedFlagForReading(p, 104.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const title = sentTitle(fetchMock);
    expect(title).toBe("[Dune] 🌡️ Very high fever — 40.3 °C / 104.5 °F");
    expect(title.match(/Dune/g)).toHaveLength(1);
    // The category label is gone: the title already opens with what crossed, and
    // "check" is the wrong verb for a message whose body says to call someone now.
    expect(title).not.toMatch(/Fever check/);

    const body = sentBody(fetchMock);
    expect(body).toBe(
      "Contact a clinician now — 104 °F / 40 °C or higher at any age. " +
        "Source: American Academy of Pediatrics."
    );
    // A lock screen truncates. The whole message is under 150 characters; the old
    // one spent 219 on four repetitions.
    expect(title.length + body.length).toBeLessThan(150);
    // The action leads; the provenance trails (copy.md rule 10). The reading is in
    // the title and appears nowhere in the body.
    expect(body.indexOf("Contact a clinician")).toBeLessThan(
      body.indexOf("Source:")
    );
    expect(body).not.toMatch(/40\.3|104\.5/);
  });
});

describe("dispatchTempRedFlagForReading (#1025)", () => {
  it("a qualifying reading through the real write core fires ONCE; a same-rule repeat holds", async () => {
    const p = newProfile("TrfDispatch");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();
    const date = today(p);

    // The write core derives the flag; the dispatch evaluates + sends immediately.
    const outcome = logTemperatureCore(p, 104.5, "F", date, "page", "14:00");
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
    const second = logTemperatureCore(p, 104.8, "F", date, "page", "16:00");
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
    logTemperatureCore(p, 100.6, "F", date, "page", "08:00");
    await dispatchTempRedFlagForReading(p, 100.6);
    expect(fetchMock).not.toHaveBeenCalled();

    // 2 PM: the fever spikes past the cited line — the push goes NOW, not tomorrow.
    const spike = logTemperatureCore(p, 104.2, "F", date, "page", "14:00");
    expect(spike.kind).toBe("logged");
    await dispatchTempRedFlagForReading(p, 104.2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an ordinary reading never reaches the notification path (cheap pre-check)", async () => {
    const p = newProfile("TrfOrdinary");
    makeSick(p, 1);
    configureHA(p);
    const fetchMock = stubFetch();
    logTemperatureCore(p, 99.1, "F", today(p), "page", "09:00");
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
    logTemperatureCore(p, 100.2, "F", date, "page", "09:00");
    logTemperatureCore(p, 104.9, "F", shiftDateStr(date, -2), "page", "21:00");
    await dispatchTempRedFlagForReading(p, 104.9);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a crossing value with NO open episode sends nothing", async () => {
    const p = newProfile("TrfNoEpisode");
    configureHA(p);
    const fetchMock = stubFetch();
    logTemperatureCore(p, 105.0, "F", today(p), "page", "10:00");
    await dispatchTempRedFlagForReading(p, 105.0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── THE DARK PHONE (#4712) ───────────────────────────────────────────────────
//
// The case directly above is the DEFECT, not a rule: an infant's first 105 °F of the
// night, logged by a caregiver who has not performed the situation-toggle ceremony,
// sent nothing while that caregiver's own screen showed the red-flag toast. Opening
// the episode is the second event that can make the finding true, and this is the
// door that re-asks.
//
// EVERY ASSERTION HERE IS ON THE DESTINATION URL, NOT ON A CALL COUNT. Each profile
// carries its OWN Home Assistant webhook, so "the push reached the child's household
// channel" and "no push reached the other profile's" are separate, observable facts.
// A count alone cannot tell a correct send from a send to the wrong person, which is
// the whole failure this door risks.
describe("dispatchTempRedFlagForEpisodeOpen (#4712)", () => {
  const CHILD_URL = "http://homeassistant.local:8123/api/webhook/allos-child";
  const OTHER_URL = "http://homeassistant.local:8123/api/webhook/allos-other";
  const urls = (mock: ReturnType<typeof stubFetch>) =>
    mock.mock.calls.map((call) => String(call[0]));

  it("the first fever of the night reaches the SUBJECT once the episode opens, and reaches nobody else", async () => {
    const child = newProfile("TrfChild");
    const other = newProfile("TrfOther");
    configureHA(child, CHILD_URL);
    configureHA(other, OTHER_URL);
    const fetchMock = stubFetch();
    const date = today(child);

    // 2 AM: the reading goes in. No episode exists, so the reading-keyed door finds
    // no finding and the phone stays dark — the defect, reproduced.
    const reading = logTemperatureCore(
      child,
      105.0,
      "F",
      date,
      "page",
      "02:00"
    );
    expect(reading.kind).toBe("logged");
    await dispatchTempRedFlagForReading(child, 105.0);
    expect(fetchMock).not.toHaveBeenCalled();

    // The offer is accepted: the episode opens through the SAME auth-blind core the
    // Server Action calls (`setActiveSituations` → `syncOpenIllnessEpisode`), not
    // through a hand-inserted row, so this exercises the real front door.
    openIllness(child);
    await dispatchTempRedFlagForEpisodeOpen(child);

    // It fired, and it fired at the child's own channel.
    expect(urls(fetchMock)).toEqual([CHILD_URL]);
    expect(urls(fetchMock)).not.toContain(OTHER_URL);
    expect(
      getProfileSettingKeysWithPrefix(child, "notify_last_tempredflag_")
    ).toHaveLength(1);
    // The other profile has no reading, no episode, and no marker.
    expect(
      getProfileSettingKeysWithPrefix(other, "notify_last_tempredflag_")
    ).toHaveLength(0);

    // Walking the door a second time does not re-nag: the per-finding marker is the
    // same one the reading path sets, so the two doors share one dedup.
    await dispatchTempRedFlagForEpisodeOpen(child);
    expect(urls(fetchMock)).toEqual([CHILD_URL]);
  });

  it("opening an episode for a profile with no crossing reading sends nothing", async () => {
    const p = newProfile("TrfOpenNoFever");
    configureHA(p, OTHER_URL);
    const fetchMock = stubFetch();
    logTemperatureCore(p, 99.4, "F", today(p), "page", "09:00");
    openIllness(p);
    await dispatchTempRedFlagForEpisodeOpen(p);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opening an episode today cannot resurrect a crossing from before it", async () => {
    // The window bound, asserted rather than assumed: `syncOpenIllnessEpisode` starts
    // the row on the toggle's own profile-local day, and the assembly windows readings
    // to `[start, …]` — so a 105.2 from two days ago is not this episode's latest
    // reading and produces no finding. Without that bound, a caregiver marking an
    // illness for an old cold would push a stale emergency line.
    const p = newProfile("TrfStaleCrossing");
    configureHA(p, CHILD_URL);
    const fetchMock = stubFetch();
    const date = today(p);
    logTemperatureCore(p, 105.2, "F", shiftDateStr(date, -2), "page", "21:00");
    openIllness(p);
    await dispatchTempRedFlagForEpisodeOpen(p);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
