// DB INTEGRATION TIER (#1714) — per-category digest demotion end to end: the
// login-scoped store, the collapse from N readers to one message, the digest gather,
// and the ⚙️ Tune keyboard driven through the real callback dispatcher.
//
// What this pins:
//   1. the preference is LOGIN-scoped — two logins watching one profile hold
//      independent state, and a toggle reports the state it actually stored;
//   2. a demoted category's ROUTINE line is absent from the next digest while its
//      NOTABLE line still appears — the floor is untouched by any preference;
//   3. expanding/collapsing Tune is a keyboard EDIT, never a send, and the keyboard
//      reflects the state after a toggle;
//   4. demoting everything still leaves the digest's non-demotable core.
//
// Only the raw Telegram transport is stubbed (the #454 guarded boundary), so the
// keyboards asserted here are the genuine rendered output.

import { vi, describe, it, expect } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => 1),
  };
});

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  digestDemotionsForProfile,
  getLoginDigestDemotions,
  setLoginDigestDemotions,
  setTimezone,
  toggleLoginDigestDemotion,
} from "@/lib/settings";
import { buildDigest } from "@/lib/notifications/digest";
import {
  digestTunableCategories,
  gatherDigestInput,
} from "@/lib/notifications/digest-data";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageReplyMarkupRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import {
  tuneExpandToken,
  tuneCollapseToken,
  tuneToggleToken,
} from "@/lib/notifications/digest-tune";
import { seedLoginTelegram } from "./fixtures";

const editKeyboardMock = vi.mocked(editMessageReplyMarkupRaw);
const answerMock = vi.mocked(answerCallbackQuery);
const sendMock = vi.mocked(sendMessageRaw);

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// An out-of-range VITALS reading — the safety-adjacent floor class.
function seedFlaggedVital(profileId: number, date: string, value: string) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, name, canonical_name, category, value, flag, created_at)
     VALUES (?, ?, 'Blood Pressure Systolic', 'Blood Pressure Systolic',
             'vitals', ?, 'high', datetime('now'))`
  ).run(profileId, date, value);
}

function seedMood(profileId: number, date: string, valence: number) {
  db.prepare(
    `INSERT INTO mood_logs (profile_id, date, valence, energy)
     VALUES (?, ?, ?, 3)`
  ).run(profileId, date, valence);
}

function digestLines(profileId: number, name: string): string[] {
  const model = buildDigest(gatherDigestInput(profileId, name));
  return (model?.sections ?? []).flatMap((s) => s.lines);
}

function tuneCq(chatId: string, data: string) {
  return {
    id: `cq-${data}`,
    data,
    message: {
      chat: { id: Number(chatId) },
      message_id: 4242,
      text: "☀️ Morning digest",
    },
  };
}

function lastKeyboard(): { text?: string; callback_data?: string }[][] {
  return (editKeyboardMock.mock.calls.at(-1)?.[2] ?? []) as {
    text?: string;
    callback_data?: string;
  }[][];
}

function lastKeyboardLabels(): string[] {
  return lastKeyboard().flat().map((b) => b.text ?? "");
}

describe("digest demotion storage — login-scoped (#1714)", () => {
  it("two logins watching ONE profile hold independent preferences", () => {
    const pid = newProfile("Shared Subject");
    const a = seedLoginTelegram(pid, "5551714001");
    const b = seedLoginTelegram(pid, "5551714002");

    setLoginDigestDemotions(a, ["mood"]);
    setLoginDigestDemotions(b, ["sleep"]);

    expect(getLoginDigestDemotions(a)).toEqual(["mood"]);
    expect(getLoginDigestDemotions(b)).toEqual(["sleep"]);
  });

  it("the toggle reports the state it actually stored, both directions", () => {
    const pid = newProfile("Toggle Tess");
    const login = seedLoginTelegram(pid, "5551714003");

    const on = toggleLoginDigestDemotion(login, "vitals");
    expect(on.demoted).toBe(true);
    expect(getLoginDigestDemotions(login)).toEqual(["vitals"]);

    const off = toggleLoginDigestDemotion(login, "vitals");
    expect(off.demoted).toBe(false);
    expect(getLoginDigestDemotions(login)).toEqual([]);
  });

  it("a toggle leaves the OTHER categories alone", () => {
    const pid = newProfile("Partial Pat");
    const login = seedLoginTelegram(pid, "5551714004");
    setLoginDigestDemotions(login, ["mood", "sleep"]);
    toggleLoginDigestDemotion(login, "mood");
    expect(getLoginDigestDemotions(login)).toEqual(["sleep"]);
  });

  it("one message, N readers: only what EVERY managing login demoted applies", () => {
    const pid = newProfile("Household Hal");
    const a = seedLoginTelegram(pid, "5551714005");
    const b = seedLoginTelegram(pid, "5551714006");
    setLoginDigestDemotions(a, ["mood", "vitals"]);
    setLoginDigestDemotions(b, ["mood"]);
    expect(digestDemotionsForProfile(pid)).toEqual(["mood"]);

    setLoginDigestDemotions(b, ["mood", "vitals"]);
    expect(digestDemotionsForProfile(pid)).toEqual(["vitals", "mood"]);
  });

  it("a profile with no managing login demotes nothing, never everything", () => {
    expect(digestDemotionsForProfile(newProfile("Unwatched Uma"))).toEqual([]);
  });
});

describe("the demoted digest (#1714)", () => {
  it("a demoted category's ROUTINE line is gone while its NOTABLE line remains", () => {
    const pid = newProfile("Digest Dara");
    const login = seedLoginTelegram(pid, "5551714010");
    const td = today(pid);
    const yd = shiftDateStr(td, -1);
    seedMood(pid, yd, 3);
    seedFlaggedVital(pid, yd, "168");

    const before = digestLines(pid, "Digest Dara");
    expect(before.some((l) => l.includes("Check-in"))).toBe(true);
    expect(before.some((l) => l.includes("Blood Pressure Systolic"))).toBe(
      true
    );

    setLoginDigestDemotions(login, ["mood", "vitals"]);
    const after = digestLines(pid, "Digest Dara");
    // The routine check-in line stops…
    expect(after.some((l) => l.includes("Check-in"))).toBe(false);
    // …while the out-of-range vital, the safety floor, is untouched by preference.
    expect(after.some((l) => l.includes("Blood Pressure Systolic"))).toBe(true);
  });

  it("a NOTABLE mood shift survives its own category's demotion", () => {
    const pid = newProfile("Shift Shay");
    const login = seedLoginTelegram(pid, "5551714011");
    const td = today(pid);
    // A deep-ish baseline of 4s, then a 1 yesterday: a shift below their own average.
    for (let d = 10; d >= 3; d--) seedMood(pid, shiftDateStr(td, -d), 4);
    seedMood(pid, shiftDateStr(td, -1), 1);
    setLoginDigestDemotions(login, ["mood"]);

    const lines = digestLines(pid, "Shift Shay");
    expect(lines.some((l) => l.includes("below your recent average"))).toBe(
      true
    );
  });

  it("demoting EVERY category leaves the digest's non-demotable core", () => {
    const pid = newProfile("Silent Sam");
    const login = seedLoginTelegram(pid, "5551714012");
    const td = today(pid);
    seedMood(pid, shiftDateStr(td, -1), 3);
    // A dose today is Today-section content: an obligation, not a tunable category.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Silent Sam D3', 1, 'supplement', 'daily', 'must')`
        )
        .run(pid).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 cap', 'morning', 'any', 0)`
    ).run(itemId);

    setLoginDigestDemotions(login, [
      "visits",
      "growth",
      "intake",
      "vitals",
      "symptoms",
      "mood",
      "data",
      "sleep",
    ]);
    const model = buildDigest(gatherDigestInput(pid, "Silent Sam"));
    expect(model).not.toBeNull();
    expect(model?.sections.some((s) => s.heading === "Today")).toBe(true);
  });

  it("the ⚙️ Tune button rides a digest that HAS tunable content, and only then", () => {
    const quiet = newProfile("Quiet Quill");
    seedLoginTelegram(quiet, "5551714013");
    expect(digestTunableCategories(quiet, today(quiet))).toEqual([]);

    const noisy = newProfile("Noisy Nell");
    seedLoginTelegram(noisy, "5551714014");
    seedMood(noisy, shiftDateStr(today(noisy), -1), 3);
    expect(digestTunableCategories(noisy, today(noisy))).toEqual(["mood"]);

    const model = buildDigest(gatherDigestInput(noisy, "Noisy Nell"));
    expect(model?.tuneTail?.data).toBe(
      tuneExpandToken(noisy, today(noisy))
    );
  });
});

describe("the ⚙️ Tune keyboard on Telegram (#1714)", () => {
  it("expands via EDIT — no message is sent — and a toggle re-renders the state", async () => {
    const pid = newProfile("Tap Tam");
    const chat = "5551714020";
    const login = seedLoginTelegram(pid, chat);
    const td = today(pid);
    seedMood(pid, shiftDateStr(td, -1), 3);
    seedFlaggedVital(pid, shiftDateStr(td, -1), "170");

    editKeyboardMock.mockClear();
    sendMock.mockClear();
    answerMock.mockClear();

    await handleCallbackQuery(tuneCq(chat, tuneExpandToken(pid, td)));
    // A keyboard edit is not a send: the phone stays silent.
    expect(sendMock).not.toHaveBeenCalled();
    expect(editKeyboardMock).toHaveBeenCalledTimes(1);
    expect(lastKeyboardLabels()).toEqual([
      "🔔 Vitals",
      "🔔 Check-in",
      "▲ Done",
    ]);

    await handleCallbackQuery(tuneCq(chat, tuneToggleToken(pid, td, "mood")));
    expect(sendMock).not.toHaveBeenCalled();
    expect(getLoginDigestDemotions(login)).toEqual(["mood"]);
    // The keyboard shows the state that was actually stored.
    expect(lastKeyboardLabels()).toEqual([
      "🔔 Vitals",
      "🔕 Check-in",
      "▲ Done",
    ]);
    // …and the tap is answered with the consequence, not a bare confirmation.
    expect(answerMock.mock.calls.at(-1)?.[1]).toContain("notable only");

    await handleCallbackQuery(tuneCq(chat, tuneCollapseToken(pid, td)));
    expect(lastKeyboardLabels()).toEqual(["⚙️ Tune"]);
  });

  it("a demoted category stays in its own toggle, so the demotion is reversible on Telegram", async () => {
    const pid = newProfile("Reverse Rye");
    const chat = "5551714021";
    const login = seedLoginTelegram(pid, chat);
    const td = today(pid);
    seedMood(pid, shiftDateStr(td, -1), 3);
    // Demote a category that produced NOTHING today — it must still be offered.
    setLoginDigestDemotions(login, ["sleep"]);

    editKeyboardMock.mockClear();
    await handleCallbackQuery(tuneCq(chat, tuneExpandToken(pid, td)));
    expect(lastKeyboardLabels()).toEqual([
      "🔔 Check-in",
      "🔕 Sleep",
      "▲ Done",
    ]);
  });

  it("a tap on YESTERDAY's digest is refused, and writes nothing", async () => {
    const pid = newProfile("Stale Stu");
    const chat = "5551714022";
    const login = seedLoginTelegram(pid, chat);
    const yd = shiftDateStr(today(pid), -1);

    editKeyboardMock.mockClear();
    answerMock.mockClear();
    await handleCallbackQuery(tuneCq(chat, tuneToggleToken(pid, yd, "mood")));

    expect(getLoginDigestDemotions(login)).toEqual([]);
    expect(editKeyboardMock).not.toHaveBeenCalled();
    expect(answerMock.mock.calls.at(-1)?.[1]).toBeTruthy();
  });

  it("a tap from a chat that cannot act as the named profile is refused", async () => {
    const mine = newProfile("Mine Mia");
    const theirs = newProfile("Theirs Theo");
    const chat = "5551714023";
    const login = seedLoginTelegram(mine, chat);
    seedLoginTelegram(theirs, "5551714024");

    editKeyboardMock.mockClear();
    await handleCallbackQuery(
      tuneCq(chat, tuneToggleToken(theirs, today(theirs), "mood"))
    );
    expect(getLoginDigestDemotions(login)).toEqual([]);
    expect(editKeyboardMock).not.toHaveBeenCalled();
  });
});
