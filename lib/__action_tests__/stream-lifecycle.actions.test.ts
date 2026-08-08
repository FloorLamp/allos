// SERVER-ACTION TIER — the four taps of the continuous-stream lifecycle (#2162).
//
// THE CONSENT SHAPE IS WHAT THESE PIN. The #2161 setting is user-owned, and the whole
// feature turns on one asymmetry (docs/internals/findings.md §2/§7):
//
//   • the ONBOARDING offer may only ever be ACCEPTED into an enable. Declining it —
//     and ignoring it, which is the same thing with no row written — enables nothing,
//     because there was nothing on to leave on.
//   • the OFFBOARDING prompt announces a reduction that already happened. "Keep" must
//     preserve the setting untouched, and only "Turn off" writes the off.
//
// Each also pins the staleness guard: every action re-derives the LIVE offer from the
// key it was handed, so a card left open on a phone while the watch came back cannot
// enable a reminder nobody is currently being offered.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { setTimezone, setProfileWearReminder } from "@/lib/settings";
import { getProfileWearReminder } from "@/lib/settings/notifications";
import { shiftDateStr, utcMinute, zonedWallTimeToUtc } from "@/lib/date";
import { getFindingSuppressions } from "@/lib/queries";
import { getStreamLifecycleOffers } from "@/lib/queries/stream-lifecycle";
import {
  streamOffboardKey,
  streamOnboardKey,
} from "@/lib/integrations/stream-lifecycle";
import {
  acceptStreamReminder,
  declineStreamReminder,
  dismissStreamReminderOffer,
  keepStreamReminder,
} from "@/app/(app)/stream-lifecycle-actions";
import { seedActor, fd } from "./harness";

const PROVIDER = "health-connect";
const TZ = "America/New_York";
const DAY = "2026-07-15";
const revalidate = vi.mocked(revalidatePath);

function nowInstant(): Date {
  return zonedWallTimeToUtc(TZ, DAY, "08:00")!;
}

function connect(profileId: number): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, ?, 'connected', NULL)`
  ).run(profileId, PROVIDER);
}

function stream(profileId: number, day: string, minutes = 5): void {
  const end = zonedWallTimeToUtc(TZ, day, "20:00")!;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 62, 60, ?)`
  );
  for (let back = 0; back < minutes; back++)
    insert.run(
      profileId,
      utcMinute(new Date(end.getTime() - back * 60_000)),
      PROVIDER
    );
}

/** A brand-new stream: rows today and nothing before — the `appeared` state. */
function seedAppeared() {
  const { profile } = seedActor({ profileName: "stream-onboard" });
  setTimezone(profile.id, TZ);
  connect(profile.id);
  stream(profile.id, DAY, 30);
  return profile;
}

/** Two months of wear, then a fortnight of silence — the `ended` state. */
function seedEnded(quietDays = 14) {
  const { profile } = seedActor({ profileName: "stream-offboard" });
  setTimezone(profile.id, TZ);
  connect(profile.id);
  for (let back = 60; back >= quietDays; back--)
    stream(profile.id, shiftDateStr(DAY, -back));
  setProfileWearReminder(profile.id, true);
  return profile;
}

beforeEach(() => {
  revalidate.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowInstant());
});
afterEach(() => vi.useRealTimers());

describe("acceptStreamReminder — the only path that turns it ON", () => {
  it("writes the setting and retires the offer", async () => {
    const profile = seedAppeared();
    const key = streamOnboardKey(PROVIDER, "heart-rate");
    expect(getStreamLifecycleOffers(profile.id)[0]?.key).toBe(key);

    const res = await acceptStreamReminder(fd({ dedupe_key: key }));
    expect(res.ok).toBe(true);
    expect(getProfileWearReminder(profile.id)).toBe(true);
    // A consented feature has nothing left to offer: the dismissal rides along so the
    // card does not reappear beside a setting that is now on.
    expect(getStreamLifecycleOffers(profile.id)).toEqual([]);
    expect(getFindingSuppressions(profile.id).has(key)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("refuses a key that is not currently being offered", async () => {
    const profile = seedAppeared();
    // A different provider's key: the guard re-derives the live offer, so a tampered
    // form cannot reach a stream nobody is being offered.
    const res = await acceptStreamReminder(
      fd({ dedupe_key: streamOnboardKey("oura", "heart-rate") })
    );
    expect(res.ok).toBe(false);
    expect(getProfileWearReminder(profile.id)).toBe(false);
  });

  it("refuses an OFFBOARDING key, so the wrong tap can never enable", async () => {
    const profile = seedAppeared();
    const res = await acceptStreamReminder(
      fd({ dedupe_key: streamOffboardKey(PROVIDER, "heart-rate", DAY) })
    );
    expect(res.ok).toBe(false);
    expect(getProfileWearReminder(profile.id)).toBe(false);
  });
});

describe("dismissStreamReminderOffer — declining enables nothing", () => {
  it("writes a suppression row and NOT the setting", async () => {
    const profile = seedAppeared();
    const key = streamOnboardKey(PROVIDER, "heart-rate");

    const res = await dismissStreamReminderOffer(fd({ dedupe_key: key }));
    expect(res.ok).toBe(true);
    // The whole consent argument, in one assertion: "opt out" is stop offering, never
    // disable — there was never anything on to turn off.
    expect(getProfileWearReminder(profile.id)).toBe(false);
    expect(getFindingSuppressions(profile.id).has(key)).toBe(true);
    expect(getStreamLifecycleOffers(profile.id)).toEqual([]);
  });

  it("stays dismissed on a later render", async () => {
    const profile = seedAppeared();
    await dismissStreamReminderOffer(
      fd({ dedupe_key: streamOnboardKey(PROVIDER, "heart-rate") })
    );
    stream(profile.id, DAY, 60);
    expect(getStreamLifecycleOffers(profile.id)).toEqual([]);
  });
});

describe("the offboarding pair — announced, not asked (§7)", () => {
  it("Keep preserves the setting and dismisses only this episode", async () => {
    const profile = seedEnded();
    const [offer] = getStreamLifecycleOffers(profile.id);
    expect(offer.kind).toBe("offboard");

    const res = await keepStreamReminder(fd({ dedupe_key: offer.key }));
    expect(res.ok).toBe(true);
    expect(getProfileWearReminder(profile.id)).toBe(true);
    expect(getStreamLifecycleOffers(profile.id)).toEqual([]);
    // Exactly one suppression row, and it is the episode key — nothing broader.
    const rows = getFindingSuppressions(profile.id);
    expect([...rows.keys()]).toEqual([offer.key]);
  });

  it("Turn off writes the off — the user's tap, never the lapse", async () => {
    const profile = seedEnded();
    const [offer] = getStreamLifecycleOffers(profile.id);

    const res = await declineStreamReminder(fd({ dedupe_key: offer.key }));
    expect(res.ok).toBe(true);
    expect(getProfileWearReminder(profile.id)).toBe(false);
    expect(getStreamLifecycleOffers(profile.id)).toEqual([]);
  });

  it("refuses once the watch has come back (a stale card cannot turn it off)", async () => {
    const profile = seedEnded();
    const [offer] = getStreamLifecycleOffers(profile.id);
    // Data arrives while the card is still open on a phone.
    stream(profile.id, DAY, 30);

    const res = await declineStreamReminder(fd({ dedupe_key: offer.key }));
    expect(res.ok).toBe(false);
    expect(getProfileWearReminder(profile.id)).toBe(true);
    expect(getFindingSuppressions(profile.id).size).toBe(0);
  });

  it("refuses an ONBOARDING key, so Keep can never be wired to an enable", async () => {
    const profile = seedEnded();
    const res = await keepStreamReminder(
      fd({ dedupe_key: streamOnboardKey(PROVIDER, "heart-rate") })
    );
    expect(res.ok).toBe(false);
    expect(getFindingSuppressions(profile.id).size).toBe(0);
  });
});

describe("write access", () => {
  it("a read-only session cannot answer an offer", async () => {
    const profile = seedAppeared();
    const { actAs, createLogin } = await import("./harness");
    const login = createLogin({ role: "member" });
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(login.id, profile.id);
    actAs(login, { id: profile.id, name: profile.name }, "read");

    await expect(
      acceptStreamReminder(
        fd({ dedupe_key: streamOnboardKey(PROVIDER, "heart-rate") })
      )
    ).rejects.toThrow();
    expect(getProfileWearReminder(profile.id)).toBe(false);
  });
});
