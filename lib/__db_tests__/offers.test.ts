import { beforeEach, describe, expect, it } from "vitest";
import { db, rawDb, today } from "@/lib/db";
import { setSetting } from "@/lib/settings/kv";
import { getNotifySchedule } from "@/lib/settings/notifications";
import { dismissalKeyEntryFor } from "@/lib/dismissal-classes";
import { OFFER_ASKED_PREFIX, trackSupplyAskedKey } from "@/lib/dismissal-keys";
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

describe("item supply offers", () => {
  it("records seeing once per item, then accepts without changing dose units", () => {
    const fx = seedProfile("track-supply-seen");
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = NULL, qty_per_dose = 2 WHERE id = ?"
    ).run(fx.supplementId);
    const instance = {
      familyId: "track-supply" as const,
      itemId: fx.supplementId,
    };
    const key = trackSupplyAskedKey(fx.supplementId);
    expect(offerFamilyForKey(key)).toEqual(instance);
    expect(dismissalKeyEntryFor(key)?.keyClass).toBe("id-keyed");
    expect(offerStands(fx.profileId, instance)).toBe(true);
    expect(markOfferAsked(fx.profileId, instance)).toBe(true);
    expect(offerStands(fx.profileId, instance)).toBe(false);
    expect(
      answerOffer(fx.profileId, instance, true, {
        supplyId: null,
        quantity: 60,
      })
    ).toBe("written");
    expect(
      db
        .prepare(
          "SELECT quantity_on_hand, qty_per_dose FROM intake_items WHERE id = ?"
        )
        .get(fx.supplementId)
    ).toEqual({ quantity_on_hand: 60, qty_per_dose: 2 });
    expect(
      answerOffer(fx.profileId, instance, true, {
        supplyId: null,
        quantity: 90,
      })
    ).toBe("stale");
    expect(askedRows(fx.profileId)).toContain(key);
  });

  it("decline changes no stock and a different item still has its own offer", () => {
    const fx = seedProfile("track-supply-decline");
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = NULL WHERE profile_id = ?"
    ).run(fx.profileId);
    expect(
      answerOffer(
        fx.profileId,
        { familyId: "track-supply", itemId: fx.supplementId },
        false
      )
    ).toBe("declined");
    expect(
      offerStands(fx.profileId, {
        familyId: "track-supply",
        itemId: fx.medicationId,
      })
    ).toBe(true);
    expect(
      db
        .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
        .get(fx.supplementId)
    ).toEqual({ quantity_on_hand: null });
    const foreign = seedProfile("track-supply-foreign");
    const forged = {
      familyId: "track-supply" as const,
      itemId: fx.supplementId,
    };
    expect(markOfferAsked(foreign.profileId, forged)).toBe(false);
    expect(
      answerOffer(foreign.profileId, forged, true, {
        supplyId: null,
        quantity: 2,
      })
    ).toBe("stale");
    expect(askedRows(foreign.profileId)).toEqual([]);
    expect(offerFamilyForKey("offer-asked:track-supply:1e2")).toBeNull();
  });

  it("rolls back the count when recording the asked state fails", () => {
    const fx = seedProfile("track-supply-atomic");
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = NULL WHERE id = ?"
    ).run(fx.supplementId);
    rawDb.exec(`CREATE TEMP TRIGGER fail_track_asked BEFORE INSERT ON upcoming_dismissals
      WHEN NEW.profile_id = ${fx.profileId} BEGIN SELECT RAISE(ABORT, 'synthetic asked failure'); END`);
    try {
      expect(() =>
        answerOffer(
          fx.profileId,
          { familyId: "track-supply", itemId: fx.supplementId },
          true,
          { supplyId: null, quantity: 60 }
        )
      ).toThrow("synthetic asked failure");
      expect(
        db
          .prepare("SELECT quantity_on_hand FROM intake_items WHERE id = ?")
          .get(fx.supplementId)
      ).toEqual({ quantity_on_hand: null });
      expect(askedRows(fx.profileId)).toEqual([]);
    } finally {
      rawDb.exec("DROP TRIGGER fail_track_asked");
    }
  });
});
