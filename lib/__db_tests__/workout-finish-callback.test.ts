// DB INTEGRATION TIER — the stale-workout nudge's "🏁 Finish workout" / "🗑 Discard"
// inline buttons (issue #1205) driven end-to-end through handleCallbackQuery against
// the REAL query + finish cores, with only the Telegram network surface stubbed.
// Proves: a Finish tap stamps end_time through the shared finishWorkoutSession core,
// EDITS the same message into the #924 post-workout-dose summary, and sets the #924
// finish marker so the hourly tick sends NO second notification; a re-tap is
// idempotent (already-finished, no double activity); an empty draft returns
// empty-draft without a 0-content activity; a cross-profile token is refused; and a
// finished session with no pending doses edits to a plain confirmation. Discard
// deletes the draft. Every value is synthetic.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { getProfileSetting } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  postWorkoutFinishMarkerKey,
  renderStaleWorkoutMessage,
} from "@/lib/notifications/workout-presence";
import { workoutFinishCallback } from "@/lib/notifications/callback-data";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

const answerMock = vi.mocked(answerCallbackQuery);
const editTextMock = vi.mocked(editMessageTextRaw);

const OWN_CHAT = "5550140";
const OTHER_CHAT = "5550141";

function lastAnswerText(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}
function lastEditedText(): string | undefined {
  return editTextMock.mock.calls.at(-1)?.[2] as string | undefined;
}

// A live strength draft: source NULL, a start time, no end_time, one logged set.
function seedLiveDraft(profileId: number, date: string): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, source, created_at, updated_at)
         VALUES (?, ?, 'strength', 'Live session', '07:00', NULL,
                 datetime('now'), datetime('now'))`
      )
      .run(profileId, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, 'Bench Press', 1, 60, 5)`
  ).run(id);
  return id;
}

// An empty started-but-nothing-logged draft (no sets, no components).
function seedEmptyDraft(profileId: number, date: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, source, created_at, updated_at)
         VALUES (?, ?, 'strength', 'Live session', '07:00', NULL,
                 datetime('now'), datetime('now'))`
      )
      .run(profileId, date).lastInsertRowid
  );
}

// A post_workout supplement with one (unlogged, pending) dose → the finish summary.
function seedPostWorkoutSupp(profileId: number): void {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, 'Creatine (test)', 1, 'supplement', 'post_workout', 'high', 0)`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '5 g', 'anytime', 'any', 0)`
  ).run(itemId);
}

// A minimal callback_query with the stale nudge's Finish/Discard keyboard.
function cq(data: string, chatId: string, text = "⏱️ Still working out?") {
  return {
    id: "cbq-fin",
    data,
    message: {
      message_id: 77,
      chat: { id: chatId },
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🏁 Finish workout", callback_data: data },
            {
              text: "🗑 Discard",
              callback_data: data.replace("wofinish", "wodiscard"),
            },
          ],
        ],
      },
    },
  };
}

let withDoses: SeededProfile;
let noDoses: SeededProfile;
let other: SeededProfile;

beforeAll(() => {
  withDoses = seedProfile("WFwith");
  seedLoginTelegram(withDoses.profileId, OWN_CHAT);
  seedPostWorkoutSupp(withDoses.profileId);

  noDoses = seedProfile("WFnone");
  seedLoginTelegram(noDoses.profileId, OWN_CHAT);

  other = seedProfile("WFother");
  seedLoginTelegram(other.profileId, OTHER_CHAT);
});

beforeEach(() => {
  answerMock.mockClear();
  editTextMock.mockClear();
});

function endTimeOf(id: number): string | null {
  return (
    db.prepare("SELECT end_time FROM activities WHERE id = ?").get(id) as {
      end_time: string | null;
    }
  ).end_time;
}

describe("Finish workout button", () => {
  it("stamps end, edits the message into the post-workout dose summary, and sets the #924 marker (no second notification)", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = workoutFinishCallback(withDoses.profileId, id, "finish");

    await handleCallbackQuery(cq(token, OWN_CHAT));

    // end_time stamped (finished), the toast is honest.
    expect(endTimeOf(id)).not.toBeNull();
    expect(lastAnswerText()).toBe("Workout finished ✅");
    // The message was transformed into the finish summary (names the pending dose).
    expect(lastEditedText()).toContain("Creatine (test)");
    // The #924 finish marker is set as delivered → the tick won't re-dispatch.
    expect(
      getProfileSetting(withDoses.profileId, postWorkoutFinishMarkerKey(id))
    ).toBe(date);
  });

  it("is idempotent: a second tap answers already-finished and does not re-stamp", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = workoutFinishCallback(withDoses.profileId, id, "finish");

    await handleCallbackQuery(cq(token, OWN_CHAT));
    const firstEnd = endTimeOf(id);
    editTextMock.mockClear();

    await handleCallbackQuery(cq(token, OWN_CHAT));
    expect(lastAnswerText()).toBe("Already finished ✅");
    expect(endTimeOf(id)).toBe(firstEnd); // unchanged
    // No re-edit surprise: the already-finished tap does not rewrite the message.
    expect(editTextMock).not.toHaveBeenCalled();
  });

  it("a finished session with no pending doses edits to a plain confirmation", async () => {
    const date = today(noDoses.profileId);
    const id = seedLiveDraft(noDoses.profileId, date);
    const token = workoutFinishCallback(noDoses.profileId, id, "finish");

    await handleCallbackQuery(cq(token, OWN_CHAT));
    expect(endTimeOf(id)).not.toBeNull();
    expect(lastEditedText()).toContain("Workout finished");
    expect(
      getProfileSetting(noDoses.profileId, postWorkoutFinishMarkerKey(id))
    ).toBe(date);
  });

  it("an empty draft returns empty-draft — no stamp, no 0-content finish", async () => {
    const date = today(noDoses.profileId);
    const id = seedEmptyDraft(noDoses.profileId, date);
    const token = workoutFinishCallback(noDoses.profileId, id, "finish");

    await handleCallbackQuery(cq(token, OWN_CHAT));
    expect(endTimeOf(id)).toBeNull(); // not finished
    expect(lastAnswerText()).toContain("Nothing logged yet");
    expect(editTextMock).not.toHaveBeenCalled(); // buttons kept for Discard
  });

  it("refuses a cross-profile token (tapped from a chat that isn't the session's profile)", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = workoutFinishCallback(withDoses.profileId, id, "finish");

    // Tapped from OTHER_CHAT (maps only to `other`, not `withDoses`).
    await handleCallbackQuery(cq(token, OTHER_CHAT));
    expect(endTimeOf(id)).toBeNull(); // nothing stamped
    expect(lastAnswerText()).toContain("out of date");
  });
});

describe("renderStaleWorkoutMessage (#1205)", () => {
  it("carries a Finish callback with the activity id + the deep-link fallback", () => {
    const msg = renderStaleWorkoutMessage(7, 99, "Ada", "https://allos.test/");
    const finish = msg.actions?.find((a) => a.data?.startsWith("wofinish:"));
    expect(finish?.data).toBe("wofinish:7:99");
    // The Discard companion carries the same id under its own prefix.
    expect(msg.actions?.find((a) => a.data === "wodiscard:7:99")).toBeTruthy();
    // Non-Telegram channels fall back to the "Open workout" deep-link.
    expect(
      msg.actions?.find((a) => a.url === "https://allos.test/training")
    ).toBeTruthy();
  });

  it("still carries the callback buttons with no deep-link base", () => {
    const msg = renderStaleWorkoutMessage(7, 99, "Ada", "");
    expect(msg.actions?.some((a) => a.data === "wofinish:7:99")).toBe(true);
    expect(msg.actions?.some((a) => a.url)).toBe(false);
  });
});

describe("Discard button", () => {
  it("deletes the abandoned draft and its sets", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = workoutFinishCallback(withDoses.profileId, id, "discard");

    await handleCallbackQuery(cq(token, OWN_CHAT));
    expect(lastAnswerText()).toContain("discarded");
    expect(
      db.prepare("SELECT 1 FROM activities WHERE id = ?").get(id)
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM exercise_sets WHERE activity_id = ?").get(id)
    ).toBeUndefined();
  });
});
