// NOTIFICATION TIER — #1685a: a broken integration reaches a push channel by RIDING the
// morning digest that already sends.
//
// Before this, a revoked grant reached nothing off-device: the `integration` domain had a
// digest noun but was omitted from DOMAIN_SEQ, and no other notification path mentioned
// reauth or auth failure. That inverts the feature's purpose — an integration exists so
// data flows WITHOUT opening the app, so a dead one is exactly the state its owner is
// least likely to notice, and a revoked token needs their consent, so waiting never fixes
// it.
//
// The load-bearing properties, all pinned here:
//   1. the digest NAMES the broken source and its provider (a bare count can't be acted on);
//   2. a healthy profile's digest is byte-identical to before — no new empty line;
//   3. there is NO new send. It is the same one-per-day digest, on the same marker, over
//      the same channels; a profile whose ONLY news is a broken sync gets that digest and
//      nothing else.
//
// Uses the digest-merge harness pattern: a real profile, a stubbed global fetch, and the
// real runDigest so the dispatch/marker fold runs.

import { describe, it, expect, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { shiftDateStr, utcInstant } from "@/lib/date";
import { setTelegramBotConfig, getProfileSetting } from "@/lib/settings";
import { runDigest, gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest } from "@/lib/notifications/digest";
import { seedLoginTelegram } from "./fixtures";
import { plainBody } from "@/lib/notifications/rich-text";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function connect(profileId: number, provider: string): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status)
     VALUES (?, ?, 'connected')
     ON CONFLICT (profile_id, provider) DO UPDATE SET status = 'connected'`
  ).run(profileId, provider);
}

// A recorded sync `hoursAgo` hours back from the app's own now. Measured against the
// CLOCK, not the calendar: the escalation rule is minute-grain silence since #2263.
function syncEvent(
  profileId: number,
  provider: string,
  hoursAgo: number,
  ok = 1,
  error: string | null = null
): void {
  // The sync ledger stores UTC with an explicit `Z` since migration 163 (#2205);
  // the fixture writes the shape the column actually holds.
  const at = utcInstant(new Date(clockNow().getTime() - hoursAgo * 3600_000));
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, error)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, provider, at, ok, error);
}

const DAYS = 24;

function seedActivityYesterday(profileId: number): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', 'Session', 45)`
  ).run(profileId, shiftDateStr(today(profileId), -1));
}

function configureTelegram(profileId: number, chatId: string): void {
  setTelegramBotConfig({
    telegramBotToken: "digest-integration-token",
    telegramMode: "poll",
  });
  seedLoginTelegram(profileId, chatId);
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

// The digest body text of the nth Telegram POST.
function sentBody(mock: ReturnType<typeof vi.fn>, n = 0): string {
  return String(JSON.parse(mock.mock.calls[n][1].body as string).text);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a broken sync rides the morning digest (#1685)", () => {
  it("names the failing provider and links its reconnect page", async () => {
    const p = newProfile("DigestReauth");
    const td = today(p);
    connect(p, "strava");
    // Silence past Strava's declared 3-day tolerance, with recorded failures inside
    // it. The silence is what escalates (#2263); the recorded failure is what the
    // line then names. Failures with a recent success behind them reach nothing.
    syncEvent(p, "strava", 5 * DAYS);
    syncEvent(p, "strava", 2, 0, "Strava token refresh failed (401): expired");
    syncEvent(p, "strava", 1, 0, "Strava token refresh failed (401): expired");
    seedActivityYesterday(p); // ordinary content, so this isn't a sync-only digest
    configureTelegram(p, "555685");
    const fetchMock = stubFetch();

    const res = await runDigest(p, "DigestReauth", td);
    expect(res.failed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = sentBody(fetchMock);
    // ONE ENTRY (#1913 items 2/5). It used to appear twice — once in the band line and
    // again as the named 🔌 line — which is the same 503 restated in one message.
    expect(body).toContain("🔌 <b>Strava sync needs attention</b>");
    expect(body).toContain("401");
    expect(body).not.toContain("🗓️ Today: Strava sync needs attention");
    expect(body.match(/Strava sync needs attention/g)).toHaveLength(1);
  });

  it("names a silently-stopped provider with the staleness copy instead", async () => {
    const p = newProfile("DigestStale");
    const td = today(p);
    connect(p, "withings");
    syncEvent(p, "withings", 25 * DAYS); // last success 25 days ago, nothing since
    seedActivityYesterday(p);
    configureTelegram(p, "555686");
    const fetchMock = stubFetch();

    await runDigest(p, "DigestStale", td);
    const body = sentBody(fetchMock);
    expect(body).toContain("Withings sync has stopped");
    expect(body).toContain("No data since");
    // The stale line must not tell the user to reconnect — see the copy rationale.
    expect(body).not.toContain("Reconnect to resume syncing");
  });

  it("adds NOTHING to a healthy profile's digest — no new line, no empty section", () => {
    const p = newProfile("DigestHealthy");
    connect(p, "strava");
    syncEvent(p, "strava", 1); // a good sync an hour ago
    seedActivityYesterday(p);

    const model = buildDigest(gatherDigestInput(p, "DigestHealthy"));
    const text = (model?.sections ?? [])
      .flatMap((s) => [s.heading, ...s.lines.map(plainBody)])
      .join("\n");
    expect(text).not.toContain("sync issue");
    expect(text).not.toContain("🔌");
  });

  it("is the ONLY channel: a profile whose sole news is a dead sync gets one digest and no other send", async () => {
    const p = newProfile("DigestOnlySync");
    const td = today(p);
    connect(p, "oura");
    syncEvent(p, "oura", 40 * DAYS);
    configureTelegram(p, "555687");
    const fetchMock = stubFetch();

    await runDigest(p, "DigestOnlySync", td);
    // Exactly one message. There is no dedicated integration notification and no
    // escalation — the digest is the whole reach (the ride-the-nag choice).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock)).toContain("Oura Ring sync has stopped");

    // …and it advances the SAME per-day marker every digest uses. The tick gates the
    // next call on that marker, so a broken sync rides the existing once-a-day message
    // rather than earning a schedule of its own — unchanged by this issue.
    expect(getProfileSetting(p, "notify_last_digest")).toBe(td);
  });

  it("stops appearing the morning after a healthy sync", () => {
    const p = newProfile("DigestSelfClear");
    connect(p, "strava");
    syncEvent(p, "strava", 12 * DAYS);
    const broken = buildDigest(gatherDigestInput(p, "DigestSelfClear"));
    expect(JSON.stringify(broken)).toContain("sync has stopped");

    syncEvent(p, "strava", 0); // the connection comes back
    const healed = buildDigest(gatherDigestInput(p, "DigestSelfClear"));
    expect(JSON.stringify(healed ?? {})).not.toContain("sync has stopped");
  });
});

// ---- The digest's sync lines consume the #1880 standing (#1913 item 2) ------
//
// The reported screenshot's exact state: a Weather & UV 503 with a successful run an
// hour earlier. That is `intermittent`, and by #1880 only `failing` and `needs-reauth`
// escalate — an intermittent source is a calm amber fact on the pull surfaces and must
// never reach a push channel. The gate is `getImportIssues`, which every one of the four
// broken-sync surfaces reads, so the digest inherits it rather than re-deriving one.
describe("the digest's sync lines consume the flap-aware standing (#1913 item 2)", () => {
  const digestText = (profileId: number, name: string): string => {
    const model = buildDigest(gatherDigestInput(profileId, name));
    return (model?.sections ?? [])
      .flatMap((s) => [s.heading, ...s.lines.map(plainBody)])
      .join("\n");
  };

  it("says nothing about an INTERMITTENT source — a failure with a success beside it", () => {
    const p = newProfile("DigestFlap");
    connect(p, "weather");
    // A success two hours ago and three failures since. Under the retired rule this
    // read "Sync failing" and reached the digest; the data is plainly arriving.
    syncEvent(p, "weather", 2);
    syncEvent(p, "weather", 1, 0, "weather fetch failed (503)");
    syncEvent(p, "weather", 0.5, 0, "weather fetch failed (503)");
    syncEvent(p, "weather", 0.2, 0, "weather fetch failed (503)");
    seedActivityYesterday(p);

    const text = digestText(p, "DigestFlap");
    expect(text).not.toContain("503");
    expect(text).not.toContain("🔌");
    expect(text).not.toContain("sync issue");
  });

  it("renders a FAILING source as exactly one entry", () => {
    const p = newProfile("DigestFailing");
    connect(p, "weather");
    // No success inside weather's 12-hour tolerance — the escalation rule.
    syncEvent(p, "weather", 20);
    for (const h of [2, 1, 0])
      syncEvent(p, "weather", h, 0, "weather fetch failed (503)");
    seedActivityYesterday(p);

    const text = digestText(p, "DigestFailing");
    expect(text).toContain("🔌");
    expect(text).toContain("503");
    // ONE entry, not a band count and a named line saying the same thing (item 5).
    expect(text.match(/sync needs attention/g)).toHaveLength(1);
    expect(text).not.toContain("sync issue");
  });
});
