// SERVER-ACTION TIER — the per-minute heart-rate window endpoint (issue #1515 D).
//
// A Route Handler, not a Server Action, but it resolves the acting identity through
// the SAME lib/auth chokepoint this tier mocks (getCurrentSession /
// getAccessibleProfiles, faithful against the real temp DB), so the auth and
// scoping paths can be driven end-to-end with a real login → profile grant matrix.
//
// What each clause is a regression class FOR:
//   • session-gated: an anonymous request reads nothing;
//   • profile-scoped: a second profile's minutes are never returned, whether asked
//     for directly (403) or by falling back to the session's active profile;
//   • clamped: an over-wide range is served at the cap rather than pulling a whole
//     day of per-minute rows;
//   • the #478 error shape on every refusal.

import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "@/app/api/intraday/hr/route";
import { db } from "@/lib/db";
import { MAX_FINE_WINDOW_MINUTES } from "@/lib/intraday-layout";
import { createLogin, createProfile, actAs } from "./harness";
import { clearActingSession } from "./session-state";

const DAY = "2026-05-14";

function seedMinutes(
  profileId: number,
  date: string,
  from: number,
  count: number,
  bpm: (i: number) => number
): void {
  const insert = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, ?, ?, ?)"
  );
  for (let i = 0; i < count; i++) {
    const m = from + i;
    const ts = `${date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
      m % 60
    ).padStart(2, "0")}`;
    insert.run(profileId, ts, bpm(i), 6, "e2e-fixture");
  }
}

async function call(
  query: Record<string, string | number>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)])
  );
  const res = await GET(new Request(`http://x/api/intraday/hr?${params}`));
  return { status: res.status, body: await res.json() };
}

describe("per-minute heart-rate window endpoint (#1515 D)", () => {
  let owner: ReturnType<typeof createLogin>;
  let mine: ReturnType<typeof createProfile>;
  let theirs: ReturnType<typeof createProfile>;

  beforeEach(() => {
    owner = createLogin({ role: "member" });
    mine = createProfile("Window subject", owner.id);
    // A profile this login has no grant on at all.
    theirs = createProfile("Someone else");
    actAs(owner, mine);
    seedMinutes(mine.id, DAY, 480, 45, (i) => 100 + i);
    seedMinutes(theirs.id, DAY, 480, 45, () => 199);
  });

  it("returns the requested window at per-minute resolution", async () => {
    const { status, body } = await call({ date: DAY, from: 480, to: 500 });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const points = body.points as { minute: number; bpm: number }[];
    expect(points).toHaveLength(21);
    expect(points[0]).toEqual({ minute: 480, bpm: 100 });
    expect(points.at(-1)).toEqual({ minute: 500, bpm: 120 });
    // Ascending, and nothing outside the window leaks in.
    expect(
      points.every((p, i) => i === 0 || p.minute > points[i - 1].minute)
    ).toBe(true);
    expect(points.every((p) => p.minute >= 480 && p.minute <= 500)).toBe(true);
  });

  it("refuses an anonymous request before reading anything", async () => {
    clearActingSession();
    const { status, body } = await call({ date: DAY, from: 480, to: 500 });
    expect(status).toBe(401);
    expect(body).toEqual({ ok: false, error: "auth" });
  });

  it("never returns a profile this login cannot reach", async () => {
    const { status, body } = await call({
      date: DAY,
      from: 480,
      to: 500,
      profile: theirs.id,
    });
    expect(status).toBe(403);
    expect(body).toEqual({ ok: false, error: "profile" });
  });

  it("serves an explicitly named profile the login DOES hold", async () => {
    const second = createProfile("Second subject", owner.id);
    seedMinutes(second.id, DAY, 600, 5, () => 55);
    const { status, body } = await call({
      date: DAY,
      from: 600,
      to: 604,
      profile: second.id,
    });
    expect(status).toBe(200);
    expect((body.points as { bpm: number }[]).every((p) => p.bpm === 55)).toBe(
      true
    );
  });

  it("falls back to the session's active profile, not another one's rows", async () => {
    const { body } = await call({ date: DAY, from: 480, to: 500 });
    const points = body.points as { bpm: number }[];
    expect(points.length).toBeGreaterThan(0);
    // 199 is the OTHER profile's fixture value; it must be unreachable from here.
    expect(points.some((p) => p.bpm === 199)).toBe(false);
  });

  it("clamps an over-wide range to the cap instead of serving the whole day", async () => {
    const { status, body } = await call({ date: DAY, from: 0, to: 1440 });
    expect(status).toBe(200);
    expect(body.from).toBe(0);
    expect(body.to).toBe(MAX_FINE_WINDOW_MINUTES);
  });

  it("rejects a malformed date or window with the #478 shape", async () => {
    expect(await call({ date: "yesterday", from: 0, to: 60 })).toMatchObject({
      status: 400,
      body: { ok: false, error: "date" },
    });
    expect(await call({ date: DAY, from: 600, to: 600 })).toMatchObject({
      status: 400,
      body: { ok: false, error: "window" },
    });
    expect(await call({ date: DAY, from: "x", to: "y" })).toMatchObject({
      status: 400,
      body: { ok: false, error: "window" },
    });
  });

  it("answers a window with no worn minutes with an empty series, not an error", async () => {
    const { status, body } = await call({ date: DAY, from: 60, to: 120 });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.points).toEqual([]);
  });
});
