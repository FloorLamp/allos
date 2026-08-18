// DB INTEGRATION TIER — the digest tail's SILENT slot-boundary refresh (#1505), and
// the ⚙️ Tune button it used to delete (#2890 decision 3).
//
// `refreshDigestOfferTail` rebuilds the digest's keyboard once per tick per profile,
// and `updateMessageKeyboard` is a wholesale replace. Rebuilding from the offer tail
// alone therefore DESTROYED the ⚙️ Tune control (#1714) on a digest that shipped with
// one — silently, at every slot boundary, on a message the reader never touched. The
// collapse path already guards this and says so in a comment; the refresh never got
// the same treatment.
//
// Why the DB tier: the defect is only observable across the pointer store, the live
// `digestTunableCategories` recompute and the rendered keyboard. A pure test can see
// the two builders, but not that one path drops one of them.
//
// NO SEND, EVER. Every assertion below is on `editMessageReplyMarkupRaw`; the
// send primitive is asserted untouched, because a keyboard edit is what makes the
// guaranteed-access tail compatible with the contact-consent rule in the first place.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, setDigestTailPointer } from "@/lib/settings";
import { refreshDigestOfferTail } from "@/lib/notifications/digest-data";
import {
  editMessageReplyMarkupRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { seedLoginTelegram } from "./fixtures";

beforeAll(() => stubTelegramSends());

const editKeyboardMock = vi.mocked(editMessageReplyMarkupRaw);
const sendMock = vi.mocked(sendMessageRaw);

const MESSAGE_ID = 2890;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Pinned so the profile-local clock this reads is the host clock, which is what
  // makes "a slot other than the current one" computable below.
  setTimezone(id, "UTC");
  return id;
}

// A `may` item with NO slot hint — offered in every slot, so the expansion count is
// the same whatever hour the suite runs at.
//
// `startedDaysAgo` backdates `intake_items.created_at`, which is what the recent-change
// collector reads for its `intake` category: an item created just now is itself a
// tunable change, so a profile that must have NOTHING to tune needs its item to predate
// the collector's window.
function seedOfferedItem(
  profileId: number,
  name: string,
  startedDaysAgo = 0
): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, created_at)
         VALUES (?, ?, 'supplement', 1, 'may', 'daily', datetime('now', ?))`
      )
      .run(profileId, name, `-${startedDaysAgo} days`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 capsule', NULL, 'any', 0)`
  ).run(itemId);
}

// Something for ⚙️ Tune to be ABOUT: a mood entry yesterday puts the `mood` category
// in today's digest, which is what `digestTunableCategories` reads.
function seedTunableCategory(profileId: number): void {
  db.prepare(
    `INSERT INTO mood_logs (profile_id, date, valence, energy) VALUES (?, ?, 3, 3)`
  ).run(profileId, shiftDateStr(today(profileId), -1));
}

// The profile-local HH:MM the host clock is at, and one in a DIFFERENT slot — so
// `offerTailNeedsRefresh` is true (or false) by construction rather than by the hour
// the suite happens to run at. Buckets: Morning < 11:00, Midday < 15:00,
// Evening < 21:00, else Before sleep.
function nowHhmm(): string {
  const d = new Date();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function anotherSlotHhmm(): string {
  return Number(nowHhmm().slice(0, 2)) < 11 ? "23:30" : "07:30";
}

function pointerAt(profileId: number, chat: string, renderedAt: string): void {
  setDigestTailPointer(profileId, {
    chatId: chat,
    messageId: MESSAGE_ID,
    date: today(profileId),
    renderedAt,
  });
}

function lastKeyboardLabels(): string[] {
  return (
    (editKeyboardMock.mock.calls.at(-1)?.[2] ?? []) as {
      text?: string;
    }[][]
  )
    .flat()
    .map((b) => b.text ?? "");
}

function lastKeyboardRows(): string[][] {
  return (
    (editKeyboardMock.mock.calls.at(-1)?.[2] ?? []) as {
      text?: string;
    }[][]
  ).map((row) => row.map((b) => b.text ?? ""));
}

beforeEach(() => {
  editKeyboardMock.mockClear();
  sendMock.mockClear();
});

describe("the collapsed keyboard is never emitted empty (#2890)", () => {
  // THE ATTACK THAT SURVIVED THE FIRST FIX. An ordinary quiet profile — nothing on
  // offer AND nothing tunable — still got `[]`, because the guard was "re-append Tune
  // IF tunable" rather than "never emit an empty keyboard". Every per-control guard
  // has a state it does not cover; the invariant does not.
  it("still renders the guaranteed access tail with nothing on offer and nothing to tune", async () => {
    const pid = newProfile("Quiet Qadir");
    const chat = "5552894";
    seedLoginTelegram(pid, chat);
    // Deliberately barren: no `may` item, no recent change, no sleep, no activity.
    pointerAt(pid, chat, anotherSlotHhmm());

    await refreshDigestOfferTail(pid);

    expect(lastKeyboardRows()).toEqual([["➕ Doses"]]);
    expect(lastKeyboardRows().flat()).not.toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // The offer tail is the GUARANTEED access path (#1505), so the rebuild emits it
  // whatever the slot holds — and the zero arm is what keeps that honest rather than
  // claiming a count it does not have.
  it("renders the zero arm rather than a stale count when the slot empties", async () => {
    const pid = newProfile("Emptied Enid");
    const chat = "5552895";
    seedLoginTelegram(pid, chat);
    seedTunableCategory(pid);
    pointerAt(pid, chat, anotherSlotHhmm());

    await refreshDigestOfferTail(pid);

    expect(lastKeyboardRows()).toEqual([["➕ Doses", "⚙️ Tune"]]);
  });
});

describe("the slot-boundary refresh keeps ⚙️ Tune (#2890)", () => {
  it("re-renders BOTH collapsed controls, on one row, and sends nothing", async () => {
    const pid = newProfile("Refresh Rina");
    const chat = "5552890";
    seedLoginTelegram(pid, chat);
    seedOfferedItem(pid, "Magnesium (tail test)");
    seedTunableCategory(pid);
    pointerAt(pid, chat, anotherSlotHhmm());

    await refreshDigestOfferTail(pid);

    expect(sendMock).not.toHaveBeenCalled();
    expect(editKeyboardMock).toHaveBeenCalledTimes(1);
    // The regression: before #2890 this was `[["➕ Log other (1 for …)"]]` — the
    // ⚙️ Tune button the digest shipped with was gone.
    expect(lastKeyboardRows()).toEqual([["➕ Doses (1)", "⚙️ Tune"]]);
  });

  it("keeps ⚙️ Tune even when the slot has emptied out", async () => {
    const pid = newProfile("Empty Elsa");
    const chat = "5552891";
    seedLoginTelegram(pid, chat);
    // No `may` item at all, so the offer half of the keyboard has nothing to say…
    seedTunableCategory(pid);
    pointerAt(pid, chat, anotherSlotHhmm());

    await refreshDigestOfferTail(pid);

    // …and the tail used to strip the whole keyboard, ⚙️ Tune with it. The offer
    // control still renders, in its zero arm — see the invariant above.
    expect(lastKeyboardLabels()).toEqual(["➕ Doses", "⚙️ Tune"]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("renders the offer tail alone when the digest has nothing to tune", async () => {
    const pid = newProfile("Untunable Uma");
    const chat = "5552892";
    seedLoginTelegram(pid, chat);
    seedOfferedItem(pid, "Zinc (tail test)", 30);
    // No tunable category seeded: ⚙️ Tune would be a control with no subject (#1714),
    // so its absence here is the rule, not the bug.
    pointerAt(pid, chat, anotherSlotHhmm());

    await refreshDigestOfferTail(pid);

    expect(lastKeyboardLabels()).toEqual(["➕ Doses (1)"]);
  });

  // The cheap no-change guard is what keeps the common tick free, and the extra
  // `digestTunableCategories` read must stay BEHIND it.
  it("makes no Bot API call at all when the slot has not turned over", async () => {
    const pid = newProfile("Quiet Quinn");
    const chat = "5552893";
    seedLoginTelegram(pid, chat);
    seedOfferedItem(pid, "Iron (tail test)");
    seedTunableCategory(pid);
    pointerAt(pid, chat, nowHhmm());

    await refreshDigestOfferTail(pid);

    expect(editKeyboardMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("uses the clock seam for the rendered slot time", async () => {
    const priorNow = process.env.ALLOS_TEST_NOW;
    try {
      process.env.ALLOS_TEST_NOW = "2026-08-18T07:30:00Z";
      const pid = newProfile("Frozen Farah");
      const chat = "5553085";
      seedLoginTelegram(pid, chat);
      seedOfferedItem(pid, "Calcium (clock seam)");
      pointerAt(pid, chat, "07:30");

      await refreshDigestOfferTail(pid);
      expect(editKeyboardMock).not.toHaveBeenCalled();

      process.env.ALLOS_TEST_NOW = "2026-08-18T23:30:00Z";
      await refreshDigestOfferTail(pid);
      expect(editKeyboardMock).toHaveBeenCalledTimes(1);
    } finally {
      if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = priorNow;
    }
  });
});
