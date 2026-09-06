import { beforeEach, describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { setSetting } from "@/lib/settings/kv";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { dismissalKeyEntryFor } from "@/lib/dismissal-classes";
import { OFFER_ASKED_PREFIX } from "@/lib/dismissal-keys";
import { ALL_NOTIFICATION_KINDS } from "@/lib/notifications/kinds";
import {
  answerOffer,
  markOfferAsked,
  OFFER_FAMILIES,
  OFFER_FAMILY_IDS,
  offerFamilyForKey,
  offerRideAlongRows,
  offerStands,
  standingOffers,
  type OfferFamilyId,
} from "@/lib/offers";
import { seedLoginTelegram, seedProfile } from "./fixtures";

// The offer-family registry (issue #4840), one row per family: the trigger is false
// before the moment, true once Telegram is reachable, and false after Yes, after No,
// and after one ignored render — each of those three under the same declared key
// class. Yes writes exactly the declared settings; No writes nothing but the key.

const CHAT = "5550400";

function profileSettings(profileId: number): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM profile_settings WHERE profile_id = ?")
    .all(profileId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function askedRows(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE ?"
      )
      .all(profileId, `${OFFER_ASKED_PREFIX}%`) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

// The moment: the bot is configured and a managing login has a live chat.
function connectTelegram(profileId: number): void {
  setSetting("telegram_bot_token", "bot-token-4840");
  seedLoginTelegram(profileId, CHAT);
}

// What each family's Yes must leave in profile_settings, and nothing else.
const EXPECTED_WRITES: Record<OfferFamilyId, Record<string, string>> = {
  "digest-on-connect": { notify_digest_hour: "07:00", digest_mode: "static" },
  "recap-on-connect": {
    notify_recap_day: "0",
    notify_recap_hour: "09:00",
    notify_recap_scale: "week",
  },
};

describe("offer-family registry (#4840)", () => {
  it("every family names a real kind, at least one surface, and a registered asked key of its declared class", () => {
    for (const id of OFFER_FAMILY_IDS) {
      const f = OFFER_FAMILIES[id];
      expect(ALL_NOTIFICATION_KINDS).toContain(f.kind);
      expect(f.surfaces.length).toBeGreaterThan(0);
      expect(dismissalKeyEntryFor(f.asked.key)?.keyClass).toBe(
        f.asked.keyClass
      );
      expect(offerFamilyForKey(f.asked.key)).toBe(id);
    }
    expect(offerFamilyForKey("offer-asked:nothing")).toBeNull();
  });

  it("renders the ride-along shape as one row per family, both answers on the row", () => {
    const rows = offerRideAlongRows(OFFER_FAMILY_IDS, (id, yes) =>
      yes ? `${id}/y` : `${id}/n`
    );
    expect(rows.map((r) => [r.row, r.data])).toEqual(
      OFFER_FAMILY_IDS.flatMap((id) => [
        [id, `${id}/y`],
        [id, `${id}/n`],
      ])
    );
    expect(rows.every((r) => r.label.length > 0)).toBe(true);
  });
});

describe.each(OFFER_FAMILY_IDS)("%s", (id) => {
  let profileId: number;
  beforeEach(() => {
    setSetting("telegram_bot_token", "");
    profileId = seedProfile(`offer-${id}`).profileId;
  });

  it("is false before the moment and true once Telegram becomes reachable", () => {
    expect(offerStands(profileId, id)).toBe(false);
    connectTelegram(profileId);
    expect(offerStands(profileId, id)).toBe(true);
    expect(standingOffers(profileId)).toContain(id);
  });

  it("Yes writes exactly the declared settings, then stops offering", () => {
    connectTelegram(profileId);
    const before = profileSettings(profileId);
    expect(answerOffer(profileId, id, true)).toBe("written");
    const after = profileSettings(profileId);
    const changed = Object.fromEntries(
      Object.entries(after).filter(([k, v]) => before[k] !== v)
    );
    expect(changed).toEqual(EXPECTED_WRITES[id]);
    expect(offerStands(profileId, id)).toBe(false);
    // The trigger itself is false now — the setting is set — so a second Yes is stale.
    expect(OFFER_FAMILIES[id].trigger(profileId, today(profileId))).toBe(false);
    expect(answerOffer(profileId, id, true)).toBe("stale");
  });

  it("No writes nothing but the asked key", () => {
    connectTelegram(profileId);
    const before = profileSettings(profileId);
    expect(answerOffer(profileId, id, false)).toBe("declined");
    expect(profileSettings(profileId)).toEqual(before);
    expect(askedRows(profileId)).toEqual([OFFER_FAMILIES[id].asked.key]);
    expect(offerStands(profileId, id)).toBe(false);
    // Still eligible by the rows, and still not offered: asked is consulted first.
    expect(OFFER_FAMILIES[id].trigger(profileId, today(profileId))).toBe(true);
  });

  it("one ignored render is an answer, under the declared key class", () => {
    connectTelegram(profileId);
    markOfferAsked(profileId, id);
    expect(offerStands(profileId, id)).toBe(false);
    expect(profileSettings(profileId)).not.toHaveProperty(
      Object.keys(EXPECTED_WRITES[id])[0]
    );
    expect(dismissalKeyEntryFor(askedRows(profileId)[0])?.keyClass).toBe(
      OFFER_FAMILIES[id].asked.keyClass
    );
  });

  it("a setting configured by hand ends the offer without a key", () => {
    connectTelegram(profileId);
    OFFER_FAMILIES[id].writes(profileId);
    expect(offerStands(profileId, id)).toBe(false);
    expect(askedRows(profileId)).toEqual([]);
    // And the schedule reader sees the same setting the form would have written.
    const s = getNotifySchedule(profileId);
    expect(
      id === "digest-on-connect" ? s.digestMinute : s.weeklyRecapDay
    ).not.toBeNull();
  });
});
