// DB INTEGRATION TIER: the calendar subscribe feed against a real (in-memory)
// SQLite handle. Proves the security-critical properties the static source scan
// can't see across helper calls:
//   1. A minted token resolves ONLY to its own profile; the feed the route serves
//      for token A contains A's appointments and NEVER B's (cross-profile isolation).
//   2. Minimal (default) reveals nothing but "Medical appointment"; Full opts into
//      provider/reason.
//   3. A cancelled appointment propagates as STATUS:CANCELLED.
//   4. A bad/disabled token yields a 404 that leaks nothing.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import {
  mintCalendarFeedToken,
  disableCalendarFeed,
  setCalendarFeedDetail,
  resolveProfileByCalendarToken,
} from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { GET } from "@/app/api/calendar/[token]/route";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addAppointment(
  profileId: number,
  scheduledAt: string,
  title: string,
  location: string | null,
  status = "scheduled"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO appointments
           (profile_id, scheduled_at, title, location, status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, scheduledAt, title, location, status).lastInsertRowid
  );
}

async function fetchFeed(
  token: string
): Promise<{ status: number; body: string }> {
  const res = await GET(new Request("http://x/api/calendar/" + token), {
    params: { token },
  });
  return { status: res.status, body: await res.text() };
}

describe("calendar feed — token resolution + cross-profile isolation", () => {
  let pa: number;
  let pb: number;
  let now: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(() => {
    pa = newProfile("CAL-A");
    pb = newProfile("CAL-B");
    now = today(pa);
    // Profile A: a timed future visit, an all-day future visit, a cancelled one,
    // and a completed one (must be excluded from the feed).
    addAppointment(
      pa,
      `${shiftDateStr(now, 3)} 14:30`,
      "AAA Cardiology",
      "Heart Center"
    );
    addAppointment(pa, shiftDateStr(now, 5), "AAA Dermatology", null);
    addAppointment(
      pa,
      shiftDateStr(now, 4),
      "AAA Cancelled",
      null,
      "cancelled"
    );
    addAppointment(
      pa,
      shiftDateStr(now, -40),
      "AAA Old done",
      null,
      "completed"
    );
    // Profile B: its own visit, distinctly titled, to prove no bleed.
    addAppointment(
      pb,
      `${shiftDateStr(now, 2)} 09:00`,
      "BBB Neurology",
      "Brain Center"
    );

    tokenA = mintCalendarFeedToken(pa);
    tokenB = mintCalendarFeedToken(pb);
  });

  it("resolves a token only to its own profile", () => {
    expect(resolveProfileByCalendarToken(tokenA)).toBe(pa);
    expect(resolveProfileByCalendarToken(tokenB)).toBe(pb);
    expect(resolveProfileByCalendarToken("deadbeef")).toBeNull();
    expect(resolveProfileByCalendarToken("")).toBeNull();
  });

  it("serves a valid calendar containing ONLY the token profile's appointments", async () => {
    const { status, body } = await fetchFeed(tokenA);
    expect(status).toBe(200);
    expect(body.startsWith("BEGIN:VCALENDAR")).toBe(true);
    // A's own appointments are present (minimal-labelled), B's are absent.
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).not.toContain("BBB");
    expect(body).not.toContain("Brain Center");
    expect(body).not.toContain("Neurology");
    // Completed visit is excluded.
    expect(body).not.toContain("Old done");
  });

  it("accepts the token with a .ics extension too", async () => {
    const { status } = await fetchFeed(`${tokenA}.ics`);
    expect(status).toBe(200);
  });

  it("minimal (default) leaks no provider/reason, keeps location", async () => {
    const { body } = await fetchFeed(tokenA);
    expect(body).toContain("SUMMARY:Medical appointment");
    expect(body).toContain("LOCATION:Heart Center");
    expect(body).not.toContain("Cardiology"); // reason withheld
  });

  it("full detail opts into provider/reason", async () => {
    setCalendarFeedDetail(pa, "full");
    const { body } = await fetchFeed(tokenA);
    expect(body).toContain("SUMMARY:AAA Cardiology");
    setCalendarFeedDetail(pa, "minimal");
  });

  it("a cancelled appointment propagates as STATUS:CANCELLED", async () => {
    const { body } = await fetchFeed(tokenA);
    expect(body).toContain("STATUS:CANCELLED");
  });

  it("a disabled feed 404s; regenerate kills the old token", async () => {
    disableCalendarFeed(pa);
    expect(resolveProfileByCalendarToken(tokenA)).toBeNull();
    expect((await fetchFeed(tokenA)).status).toBe(404);

    const fresh = mintCalendarFeedToken(pa);
    expect(fresh).not.toBe(tokenA);
    // The old token stays dead; the new one works.
    expect((await fetchFeed(tokenA)).status).toBe(404);
    expect((await fetchFeed(fresh)).status).toBe(200);
  });

  it("a bad token 404s with a generic body (no info leak)", async () => {
    const { status, body } = await fetchFeed("not-a-real-token");
    expect(status).toBe(404);
    expect(body).not.toContain("BEGIN:VCALENDAR");
  });
});
