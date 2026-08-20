// SERVER-ACTION TIER — the travel timezone actions (issue #3263).
//
// The invariant this tier exists to pin is the one that would silently move somebody
// else's day: A DEVICE IS NOT A SUBJECT. The browser zone says where this phone is,
// and nothing at all about where a profile the login merely acts FOR should run its
// day. So every action resolves the login's OWN profile and refuses unless it is
// also the acting one — and that refusal has to hold against a direct call, because
// the banner being hidden is only the UI half of it.
//
// Also proves the three writes the acceptance criteria name: the switch remembers
// home, the revert clears it and answers with both zones for the tell-after, and a
// dismissal is scoped to the zone it dismissed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  getDismissedTravelZone,
  getHomeTimezone,
  getTimezone,
  getTravelSwitches,
  getTravelTell,
  setTimezone,
} from "@/lib/settings";
import {
  acceptTravelTimezone,
  dismissTravelTimezone,
  revertTravelTimezone,
  acknowledgeTravelTell,
} from "@/app/(app)/travel-actions";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const PARIS = "Europe/Paris";

function ownProfile(name: string, tz: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
    profile.id,
    login.id
  );
  actAs(login, profile);
  setTimezone(profile.id, tz);
  return { login, profile };
}

beforeEach(() => {
  revalidate.mockClear();
  process.env.ALLOS_TEST_NOW = "2026-05-01T14:00:00Z";
});

// `process.env` is PROCESS-global and this tier shares a worker across files, so a
// frozen clock left standing here is a frozen clock for every file that runs after
// — which reads as a fault in THEIR code, at a date none of them chose. Leaving it
// set cost three unrelated files a red (a PRN countdown "in ~2655.7h", a niggle
// dated "today" instead of "yesterday", a digest slot that had turned over) before
// this line existed.
afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

describe("acceptTravelTimezone", () => {
  it("moves the day and remembers where it came from", async () => {
    const { profile } = ownProfile("traveller", NY);
    await expect(acceptTravelTimezone(TOKYO)).resolves.toEqual({
      ok: true,
      timezone: TOKYO,
    });
    expect(getTimezone(profile.id)).toBe(TOKYO);
    expect(getHomeTimezone(profile.id)).toBe(NY);
    expect(getTravelSwitches(profile.id)).toEqual([
      { at: "2026-05-01T14:00:00Z", from: NY, to: TOKYO },
    ]);
    expect(today(profile.id)).toBe("2026-05-01");
  });

  it("keeps the ORIGINAL home across a second leg", async () => {
    // Two legs of one journey are still one journey away from home: adopting the
    // last airport as home is how the return leg stops being recognisable.
    const { profile } = ownProfile("two-legs", NY);
    await acceptTravelTimezone(TOKYO);
    await acceptTravelTimezone(PARIS);
    expect(getTimezone(profile.id)).toBe(PARIS);
    expect(getHomeTimezone(profile.id)).toBe(NY);
  });

  it("refuses a zone that is not a real zone", async () => {
    const { profile } = ownProfile("bad-zone", NY);
    await expect(acceptTravelTimezone("Mars/Olympus")).resolves.toEqual({
      ok: false,
    });
    expect(getTimezone(profile.id)).toBe(NY);
  });

  it("REFUSES when the login is acting for someone else's profile", async () => {
    // The whole gate. A member with write access to a household member holds the
    // traveller's phone; the browser says Tokyo; the other person's day must not
    // move. The banner is hidden for them, and this is the half a forged POST meets.
    const login = createLogin();
    const own = createProfile("carer-own", login.id);
    const other = createProfile("someone-else", login.id);
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      own.id,
      login.id
    );
    setTimezone(other.id, NY);
    actAs(login, other);

    await expect(acceptTravelTimezone(TOKYO)).resolves.toEqual({ ok: false });
    expect(getTimezone(other.id)).toBe(NY);
    expect(getTravelSwitches(other.id)).toEqual([]);
    expect(getHomeTimezone(other.id)).toBeNull();
  });

  it("REFUSES for a login with no own profile at all", async () => {
    // A caregiver-only login has no defined self, so there is no profile whose day
    // this device's location may speak for.
    const login = createLogin();
    const profile = createProfile("no-self", login.id);
    setTimezone(profile.id, NY);
    actAs(login, profile);
    await expect(acceptTravelTimezone(TOKYO)).resolves.toEqual({ ok: false });
    expect(getTimezone(profile.id)).toBe(NY);
  });
});

describe("revertTravelTimezone", () => {
  it("moves the day home, clears the home marker, and names both zones", async () => {
    const { profile } = ownProfile("returning", NY);
    await acceptTravelTimezone(TOKYO);

    const result = await revertTravelTimezone();
    expect(result).toEqual({
      ok: true,
      timezone: NY,
      homeZone: NY,
      awayZone: TOKYO,
    });
    expect(getTimezone(profile.id)).toBe(NY);
    expect(getHomeTimezone(profile.id)).toBeNull();
    // The return leg leaves its own seam in the wall clock and joins the history.
    expect(getTravelSwitches(profile.id)).toHaveLength(2);
    // THE TELL IS DURABLE, and that is the point of storing it rather than
    // returning it. #2471 permits the unasked revert only because it reports
    // afterwards, so the report has to outlive the request that caused it — a
    // person who navigates mid-revert must still be told their day moved.
    expect(getTravelTell(profile.id)).toBe(TOKYO);
  });

  it("keeps the tell until it is acknowledged, then drops it", async () => {
    const { profile } = ownProfile("returning-ack", NY);
    await acceptTravelTimezone(TOKYO);
    await revertTravelTimezone();
    // Still owed after an unrelated read — nothing about rendering spends it.
    expect(getTravelTell(profile.id)).toBe(TOKYO);

    await expect(acknowledgeTravelTell()).resolves.toEqual({ ok: true });
    expect(getTravelTell(profile.id)).toBeNull();
    // Acknowledging a message is not a journey: the day does not move.
    expect(getTimezone(profile.id)).toBe(NY);
    expect(getTravelSwitches(profile.id)).toHaveLength(2);
  });

  it("does nothing for a profile that is not away", async () => {
    const { profile } = ownProfile("never-left", NY);
    await expect(revertTravelTimezone()).resolves.toEqual({ ok: false });
    expect(getTimezone(profile.id)).toBe(NY);
  });

  it("REFUSES when the login is acting for someone else's profile", async () => {
    const login = createLogin();
    const own = createProfile("carer-own-2", login.id);
    const other = createProfile("someone-else-2", login.id);
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      own.id,
      login.id
    );
    setTimezone(other.id, TOKYO);
    actAs(login, other);
    await expect(revertTravelTimezone()).resolves.toEqual({ ok: false });
    expect(getTimezone(other.id)).toBe(TOKYO);
  });
});

describe("dismissTravelTimezone", () => {
  it("records the dismissal against the zone it dismissed", async () => {
    const { profile } = ownProfile("not-now", NY);
    await expect(dismissTravelTimezone(TOKYO)).resolves.toEqual({ ok: true });
    expect(getDismissedTravelZone(profile.id)).toBe(TOKYO);
    // A dismissal is not a switch — the day has not moved.
    expect(getTimezone(profile.id)).toBe(NY);
    expect(getTravelSwitches(profile.id)).toEqual([]);
  });

  it("is spent once the offer is accepted", async () => {
    const { profile } = ownProfile("dismiss-then-accept", NY);
    await dismissTravelTimezone(TOKYO);
    await acceptTravelTimezone(TOKYO);
    expect(getDismissedTravelZone(profile.id)).toBeNull();
  });

  it("REFUSES when the login is acting for someone else's profile", async () => {
    const login = createLogin();
    const own = createProfile("carer-own-3", login.id);
    const other = createProfile("someone-else-3", login.id);
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      own.id,
      login.id
    );
    actAs(login, other);
    await expect(dismissTravelTimezone(TOKYO)).resolves.toEqual({ ok: false });
    expect(getDismissedTravelZone(other.id)).toBeNull();
  });
});
