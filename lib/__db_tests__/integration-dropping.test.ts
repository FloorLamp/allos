// DB INTEGRATION TIER — #4956: a source that is ALIVE and swallowing a record type.
//
// The state nothing in the failing/stale vocabulary could describe: every run `ok`,
// rows landing, the card green — and one record type arriving in every push and being
// discarded, because the exporter renamed the field the parser reads. It ran for six
// days across 405 `ok` pushes on prod and the only trace was one line on one history
// page, so the signal here is the whole point of the issue: the per-run tally makes the
// drop derivable, and `dropping` gives it the same escalation a quiet stop already has.
//
// Built from real rows through the real reads, in the #1685 harness pattern.
//
// #4975 adds the second half at the bottom: the same evidence, read as a STANDING, so
// the source's own row says it too — Review's needs-attention card reads
// `isEscalatedSource`, never an `AttentionIntegration`, and a new attention KIND is
// invisible to it by construction.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { utcInstant } from "@/lib/date";
import {
  getConnectedSources,
  getIntegrationAttention,
  getIntegrationState,
} from "@/lib/queries/integrations";
import { isEscalatedSource } from "@/components/ConnectedSources";
import { isEscalatingIntegration, integrationToItem } from "@/lib/attention";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest } from "@/lib/notifications/digest";
import { plainBody } from "@/lib/notifications/rich-text";
import type { SyncTypeTally } from "@/lib/integrations/health-connect";

const HC = "health-connect";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function connect(profileId: number, sourceId = HC): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, source_id, status)
     VALUES (?, ?, 'connected')
     ON CONFLICT (profile_id, source_id) DO UPDATE SET status = 'connected'`
  ).run(profileId, sourceId);
}

// One recorded push `hoursAgo` back, carrying the per-type tally the parser writes.
// Measured against the CLOCK because the window is the source's minute-grain silence
// tolerance (#2263), which Health Connect declares as 12 h.
function push(
  profileId: number,
  hoursAgo: number,
  tally: SyncTypeTally,
  ok = 1
): void {
  const at = utcInstant(new Date(clockNow().getTime() - hoursAgo * 3600_000));
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, source_id, at, ok, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, HC, at, ok, JSON.stringify({ tally }));
}

const DROPPING_HRV: SyncTypeTally = {
  steps: { received: 4, landed: 4 },
  heart_rate_variability: { received: 12, landed: 0 },
};

const LANDING_HRV: SyncTypeTally = {
  steps: { received: 4, landed: 4 },
  heart_rate_variability: { received: 12, landed: 12 },
};

// A Health Connect connection whose bearer token has LAPSED (#607) — still
// `connected`, still pushing until an hour ago, and reported as a failing source by a
// path that does not need a failed sync event. The only state in which a source can be
// both live-and-dropping and already-broken.
function expireToken(profileId: number): void {
  db.prepare(
    `UPDATE integration_connections SET config = ?
      WHERE profile_id = ? AND source_id = ?`
  ).run(
    JSON.stringify({
      tokenHash: "token hash 42",
      tokenExpiresAt: utcInstant(new Date(clockNow().getTime() - 3600_000)),
    }),
    profileId,
    HC
  );
}

function attention(profileId: number) {
  return getIntegrationAttention(profileId);
}

describe("a live source dropping a record type (#4956)", () => {
  it("raises an escalating dropping row that names the type and the window", () => {
    const p = newProfile("DropHrv");
    connect(p);
    for (const hoursAgo of [11, 6, 2, 0]) push(p, hoursAgo, DROPPING_HRV);

    const rows = attention(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: HC, kind: "dropping" });
    // The row names the type and the window it has been true over, so the person can
    // act without opening the history page to find out what "dropping" refers to.
    expect(rows[0].detail).toBe(
      "Heart rate variability arrived in every sync for the last 12 hours and none were stored. Check the sync history."
    );
    // It escalates for the same reason a quiet stop does — the person is losing data
    // they believe they are collecting — through the gate that already exists.
    expect(isEscalatingIntegration(rows[0])).toBe(true);
    expect(integrationToItem(rows[0]).title).toBe(
      "Google Health Connect is dropping records"
    );
  });

  it("clears the moment one record of the type lands", () => {
    // No separate resolution step and nothing to dismiss: the derivation reads the
    // window fresh, so a single landing in it leaves nothing to report. Its own
    // profile rather than a second read of the one above, because
    // getIntegrationAttention is memoized per request and per tick.
    const p = newProfile("DropRecovered");
    connect(p);
    for (const hoursAgo of [11, 6, 2]) push(p, hoursAgo, DROPPING_HRV);
    push(p, 0, {
      steps: { received: 4, landed: 4 },
      heart_rate_variability: { received: 12, landed: 12 },
    });
    expect(attention(p)).toEqual([]);
  });

  it("says nothing about a source whose type keeps landing", () => {
    const p = newProfile("DropHealthy");
    connect(p);
    for (const hoursAgo of [11, 6, 2, 0])
      push(p, hoursAgo, {
        heart_rate_variability: { received: 12, landed: 12 },
      });
    expect(attention(p)).toEqual([]);
  });

  it("ignores a drop recorded outside the source's silence tolerance", () => {
    // The window is the tolerance, not the retained ledger: a type that was dropping
    // two days ago is not a live problem, and a row that outlived its cause would be an
    // alert nobody could clear.
    //
    // The recent pushes deliberately carry NO HRV entry at all rather than a landing
    // one: a landing would clear the type through the other half of the rule, and the
    // test would pass without the window ever being consulted. A type simply absent
    // from a push has to say nothing either way — which is also what makes a nightly
    // type safe to judge over a window full of daytime pushes.
    const p = newProfile("DropOld");
    connect(p);
    push(p, 40, DROPPING_HRV);
    push(p, 30, DROPPING_HRV);
    push(p, 6, { steps: { received: 4, landed: 4 } });
    push(p, 1, { steps: { received: 4, landed: 4 } });
    expect(attention(p)).toEqual([]);
  });

  it("ignores a FAILED run's tally", () => {
    // A run that threw has no honest accounting of what it received, and a source whose
    // runs are failing is already described by `failing`.
    const p = newProfile("DropFailed");
    connect(p);
    push(p, 2, DROPPING_HRV, 0);
    expect(attention(p).filter((r) => r.kind === "dropping")).toEqual([]);
  });

  it("yields to a source that is already reported broken", () => {
    // One row per source is the rule every one of these signals obeys, and "reconnect
    // it" outranks "one of its types isn't landing" — you cannot act on the second
    // until the first is fixed.
    //
    // The overlap has to be built through the EXPIRED-TOKEN issue (#607), because it is
    // the only one that reaches a live source: `failing` and `stale` both mean no
    // successful run inside the tolerance, and a dropping source is defined by having
    // them. An expired token is the real case — the phone pushed for eleven hours,
    // dropping HRV, and the token lapsed an hour ago.
    const p = newProfile("DropAndExpired");
    connect(p);
    push(p, 11, DROPPING_HRV);
    push(p, 6, DROPPING_HRV);
    push(p, 2, DROPPING_HRV);
    expireToken(p);
    const rows = attention(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("failing");
  });

  it("reaches the morning digest's integration section without a new send", () => {
    const p = newProfile("DropDigest");
    connect(p);
    for (const hoursAgo of [11, 6, 2, 0]) push(p, hoursAgo, DROPPING_HRV);
    const text = (
      buildDigest(gatherDigestInput(p, "DropDigest"))?.sections ?? []
    )
      .flatMap((s) => [s.heading, ...s.lines.map(plainBody)])
      .join("\n");
    expect(text).toContain("Google Health Connect is dropping records");
    expect(text).toContain("Heart rate variability");
  });
});

// A source's own row, not the attention list (#4975). Review's needs-attention card
// filters `getConnectedSources` through `isEscalatedSource` — the standing axis — so
// the `dropping` KIND above cannot reach it and the standing is what does.
describe("the standing a live dropping source carries (#4975)", () => {
  function standingFor(profileId: number) {
    return getIntegrationState(profileId, HC)?.standing;
  }

  it("carries the standing, names the types, and lands on the escalated card", () => {
    const p = newProfile("StandDrop");
    connect(p);
    for (const hoursAgo of [11, 6, 2, 0]) push(p, hoursAgo, DROPPING_HRV);

    const state = getIntegrationState(p, HC);
    expect(state?.standing).toBe("dropping");
    // The evidence rides with it, so the surfaces can say WHICH data is being lost
    // rather than only that some is. `steps` lands every push and never appears.
    expect(state?.droppedTypes).toEqual(["heart_rate_variability"]);
    // THE DELIVERABLE: the card's own filter, unchanged, now admits it.
    expect(getConnectedSources(p).filter(isEscalatedSource).map((s) => s.id)).toEqual(
      [HC]
    );
  });

  it.each([
    [
      "clears the moment one record of the type lands",
      // No resolution step and nothing to dismiss — the window is re-read.
      [{ h: 11, t: DROPPING_HRV }, { h: 0, t: LANDING_HRV }],
      "healthy",
    ],
    [
      "says nothing about a source whose type keeps landing",
      [{ h: 6, t: LANDING_HRV }, { h: 0, t: LANDING_HRV }],
      "healthy",
    ],
    [
      "does not follow a merely STALE source into it",
      // The drop is real but two days old, so it is outside the window on both
      // halves: the source is silent, and `failing` is the honest verdict.
      [{ h: 40, t: DROPPING_HRV }, { h: 30, t: DROPPING_HRV }],
      "failing",
    ],
  ])("%s", (_why, pushes, expected) => {
    const p = newProfile(`Stand${expected}${pushes[0].h}`);
    connect(p);
    for (const { h, t } of pushes) push(p, h, t);
    expect(standingFor(p)).toBe(expected);
  });

  it("stays needs-reauth while the credential is dead", () => {
    // The only overlap the query layer can actually produce. `failing`-by-silence
    // cannot co-occur with `dropping` — a successful run inside the tolerance is what
    // makes a type dropped, and the same run is what makes the source not silent — so
    // this is the precedence that has real rows behind it. A source told to reconnect
    // must not be re-described as one quietly losing a type.
    const p = newProfile("StandReauth");
    connect(p);
    for (const hoursAgo of [11, 6, 2, 0]) push(p, hoursAgo, DROPPING_HRV);
    db.prepare(
      `UPDATE integration_connections SET status = 'needs_reauth'
        WHERE profile_id = ? AND source_id = ?`
    ).run(p, HC);
    expect(standingFor(p)).toBe("needs-reauth");
    expect(getIntegrationState(p, HC)?.droppedTypes).toEqual([]);
  });
});
