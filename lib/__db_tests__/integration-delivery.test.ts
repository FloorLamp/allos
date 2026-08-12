// DB INTEGRATION TIER — #2301: the state model answers the question its DELIVERY
// family actually poses.
//
// `SourceStanding` was one flat vocabulary of seven states, every one describing a
// LIVE CONNECTION allos depends on, applied to four sources that have none. These
// are the four shapes found on the prod snapshot the issue was opened on, as fixtures,
// read through the real query path (getIntegrationState → resolveSourceFacts →
// sourceStanding) rather than the pure derivation alone — because the defect was
// visible only once the registry's kind, the connection row and the recorded events
// were composed together.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { utcInstant } from "@/lib/date";
import {
  getImportIssues,
  getImportReviewCount,
  getIntegrationAttention,
  getIntegrationState,
  getConnectedSources,
} from "@/lib/queries/integrations";
import { getImportDocumentsFeed } from "@/lib/queries/imports";
import {
  standingBadge,
  standingEscalates,
  syncRunNounForKind,
} from "@/lib/integrations/source-state";

const TAKEOUT = "fitbit-takeout";
const PORTALS = "patient-portals";
const FEED = "calendar-feed";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function connect(
  profileId: number,
  sourceId: string,
  status = "connected"
): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status)
     VALUES (?, ?, ?)
     ON CONFLICT (profile_id, provider) DO UPDATE SET status = excluded.status`
  ).run(profileId, sourceId, status);
}

// An event `daysAgo` days back from the app's own now, on the ledger's canonical
// UTC+`Z` convention (migration 163).
function syncEvent(
  profileId: number,
  sourceId: string,
  daysAgo: number,
  ok: number,
  error: string | null = null
): void {
  const at = utcInstant(
    new Date(clockNow().getTime() - daysAgo * 24 * 3600_000)
  );
  db.prepare(
    `INSERT INTO integration_sync_events
       (profile_id, provider, at, ok, inserted, updated, unchanged, error)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(profileId, sourceId, at, ok, ok ? 3 : null, error);
}

describe("an ARCHIVE import is not a connection (#2301)", () => {
  it("reads `imported` and states WHEN, never a green Connected", () => {
    // The prod row exactly: one ok event, ten days old. It rendered "Connected",
    // green — for a file somebody downloaded from Google a week and a half ago.
    const p = newProfile("TakeoutImported");
    connect(p, TAKEOUT);
    syncEvent(p, TAKEOUT, 10, 1);

    const state = getIntegrationState(p, TAKEOUT)!;
    expect(state.delivery).toBe("attended");
    expect(state.standing).toBe("imported");

    const badge = standingBadge(state.standing, syncRunNounForKind(state.kind));
    expect(badge.label).toBe("Last import");
    expect(badge.label).not.toBe("Connected");
    // `good` is a health verdict, and this is not a source allos drives.
    expect(badge.tone).toBe("neutral");
  });

  it("says `never-imported` when set up with nothing in, and `not-set-up` otherwise", () => {
    // PROMOTED from the Fitbit page's own hand-rolled three: "Set up, but nothing
    // imported yet." / "No archive imported yet."
    const setUp = newProfile("TakeoutEmpty");
    connect(setUp, TAKEOUT);
    expect(getIntegrationState(setUp, TAKEOUT)!.standing).toBe(
      "never-imported"
    );

    const untouched = newProfile("TakeoutUntouched");
    expect(getIntegrationState(untouched, TAKEOUT)!.standing).toBe(
      "not-set-up"
    );
  });

  it("calls a failed import a failed IMPORT — the state the hand-rolled version lacked", () => {
    const p = newProfile("TakeoutFailed");
    connect(p, TAKEOUT);
    syncEvent(p, TAKEOUT, 3, 1);
    syncEvent(p, TAKEOUT, 1, 0, "archive unreadable");

    const state = getIntegrationState(p, TAKEOUT)!;
    // Before #2301 a failed Takeout import read `intermittent` — a flapping
    // CONNECTION, for a file.
    expect(state.standing).toBe("attempt-failed");
    expect(standingBadge(state.standing, "import").label).toBe(
      "Last import failed"
    );
    // An attention item, never an escalation: only the user knows whether they will
    // run it again, so allos may not claim the source is *still* broken.
    expect(standingEscalates(state.standing)).toBe(false);
    expect(getImportIssues(p)).toEqual([]);
    expect(getIntegrationAttention(p)).toEqual([]);
  });

  it("never goes stale, however old the last import is", () => {
    // A year-old archive is not a fault: allos cannot start this, so it may never
    // call it late.
    const p = newProfile("TakeoutAncient");
    connect(p, TAKEOUT);
    syncEvent(p, TAKEOUT, 400, 1);
    const state = getIntegrationState(p, TAKEOUT)!;
    expect(state.standing).toBe("imported");
    expect(state.stale).toBeNull();
    expect(getImportReviewCount(p)).toBe(0);
  });
});

describe("an OUTBOUND feed records no runs, so it promises none (#2301)", () => {
  it("reads `feed-enabled` with zero events and offers no run noun at all", () => {
    // The prod row: a connected calendar-feed with 0 events, rendering "Connected",
    // green, plus "No syncs yet" — permanently, because nothing will ever sync in.
    const p = newProfile("FeedOn");
    connect(p, FEED);

    const state = getIntegrationState(p, FEED)!;
    expect(state.delivery).toBe("outbound");
    expect(state.standing).toBe("feed-enabled");
    expect(state.latest).toBeNull();
    // NULL run noun is what makes "No syncs yet" unrenderable rather than merely
    // discouraged: there is no word for a run here.
    expect(syncRunNounForKind(state.kind)).toBeNull();

    const badge = standingBadge(state.standing, syncRunNounForKind(state.kind));
    expect(badge).toEqual({ label: "Feed enabled", tone: "neutral" });
  });

  it("reads `feed-off` once the feed is disabled", () => {
    const p = newProfile("FeedOff");
    connect(p, FEED, "disconnected");
    const state = getIntegrationState(p, FEED)!;
    expect(state.standing).toBe("feed-off");
    expect(standingEscalates(state.standing)).toBe(false);
  });
});

describe("an ATTENDED tool is read by its LAST ATTEMPT (#2301)", () => {
  it("never reads `intermittent`, whatever its failure mix", () => {
    // The prod row: patient-portals with 6 recorded runs, 3 of them failed, the
    // newest fine. The connection model called that "Intermittent" — and the
    // standing's own contract ("a successful run landed inside the source's
    // silence tolerance") is vacuous, because that tolerance is null.
    const p = newProfile("PortalsMixed");
    connect(p, PORTALS);
    syncEvent(p, PORTALS, 6, 1);
    syncEvent(p, PORTALS, 5, 0, "portal sign-in timed out");
    syncEvent(p, PORTALS, 4, 1);
    syncEvent(p, PORTALS, 3, 0, "portal sign-in timed out");
    syncEvent(p, PORTALS, 2, 0, "portal sign-in timed out");
    syncEvent(p, PORTALS, 1, 1);

    const state = getIntegrationState(p, PORTALS)!;
    expect(state.delivery).toBe("attended");
    expect(state.standing).toBe("imported");
    expect(state.standing).not.toBe("intermittent");
    expect(
      standingBadge(state.standing, syncRunNounForKind(state.kind))
    ).toEqual({ label: "Last upload", tone: "neutral" });
  });
});

describe("the attended family reaches Review at all (#2301)", () => {
  // THE LIVE CONSEQUENCE the issue names. The Imports feed enumerated the attended
  // family in SQL by naming ONE of its two members (`source = 'fitbit-takeout'`),
  // so a portal run appeared on NO Review surface: Connected sources excludes the
  // kind, the feed excluded the source, and getImportIssues cannot reach it because
  // an attended source is exempt from the silence rule and can never be `failing`.
  it("puts a portal run — failures included — in the chronological Imports feed", () => {
    const p = newProfile("PortalsFeed");
    connect(p, PORTALS);
    syncEvent(p, PORTALS, 4, 1);
    syncEvent(p, PORTALS, 2, 0, "portal sign-in timed out");

    const syncs = getImportDocumentsFeed(p, 100).filter(
      (e) => e.stream === "sync"
    );
    expect(syncs).toHaveLength(2);
    expect(syncs.map((e) => e.stream === "sync" && e.event.sourceId)).toEqual([
      PORTALS,
      PORTALS,
    ]);
    // The failure is the newest, and it is VISIBLE — which is the whole point.
    const newest = syncs[0];
    expect(newest.stream === "sync" && newest.event.ok).toBe(0);
    expect(newest.stream === "sync" && newest.event.error).toBe(
      "portal sign-in timed out"
    );
  });

  it("keeps BOTH attended providers in that feed, read from the family not the id", () => {
    const p = newProfile("AttendedBoth");
    connect(p, PORTALS);
    connect(p, TAKEOUT);
    syncEvent(p, PORTALS, 3, 1);
    syncEvent(p, TAKEOUT, 2, 1);

    const sourceIds = getImportDocumentsFeed(p, 100)
      .filter((e) => e.stream === "sync")
      .map((e) => (e.stream === "sync" ? e.event.sourceId : ""))
      .sort();
    expect(sourceIds).toEqual([TAKEOUT, PORTALS].sort());
  });

  it("still contributes nothing to getImportIssues or Connected sources", () => {
    // Visible on a calm chronological surface; absent from every escalation one, and
    // still not a "connected source" — its runs are events, not a link.
    const p = newProfile("PortalsNoEscalation");
    connect(p, PORTALS);
    syncEvent(p, PORTALS, 2, 0, "portal sign-in timed out");

    expect(getImportIssues(p)).toEqual([]);
    expect(getIntegrationAttention(p)).toEqual([]);
    expect(getImportReviewCount(p)).toBe(0);
    expect(getConnectedSources(p).map((s) => s.id)).not.toContain(PORTALS);
  });
});

describe("the scheduled family is untouched (#2301)", () => {
  it("still derives every connection verdict exactly as before", () => {
    // This refactor must not move a single scheduled verdict — the seven-state
    // derivation moved into the `scheduled` branch verbatim. (integration-flap and
    // integration-staleness pin the boundaries; this is the shape check beside them.)
    const p = newProfile("SchedulingUnchanged");
    connect(p, "weather");
    expect(getIntegrationState(p, "weather")!.delivery).toBe("scheduled");
    expect(getIntegrationState(p, "weather")!.standing).toBe("never-synced");

    syncEvent(p, "weather", 0, 1);
    expect(getIntegrationState(p, "weather")!.standing).toBe("healthy");
    expect(standingBadge("healthy").tone).toBe("good");

    // …and the Connected-sources set is still exactly the scheduled sources.
    for (const source of getConnectedSources(p)) {
      expect(source.delivery, source.id).toBe("scheduled");
    }
  });
});
