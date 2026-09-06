// DB INTEGRATION TIER — the "Still going?" nudge's "🏁 Finish" / "🗑️ Discard" inline
// buttons (issue #1205, one family across every open episode at #5142) driven
// end-to-end through handleCallbackQuery against the REAL query + finish cores, with
// only the Telegram network surface stubbed.
// Proves: a Finish tap stamps end_time through the shared finishWorkoutSession core,
// EDITS the same message into the #924 post-workout-dose summary, and sets the #924
// finish marker so the hourly tick sends NO second notification; a re-tap is
// idempotent (already-finished, no double activity); an empty draft returns
// empty-draft without a 0-content activity; a cross-profile token is refused; and a
// finished session with no pending doses edits to a plain confirmation. Discard
// deletes the draft. The practice kind rides the same tap into its own cores.
// Every value is synthetic.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { getProfileSetting } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { postWorkoutFinishMarkerKey } from "@/lib/notifications/workout-presence";
import { stillGoingCallback } from "@/lib/notifications/callback-data";
import { renderStillGoingMessage } from "@/lib/notifications/still-going";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";
import { startLivePracticeSession, getPracticeSessions } from "@/lib/queries";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

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
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Creatine (test)', 1, 'supplement', 'post_workout', 'should')`
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
              text: "🗑️ Discard",
              callback_data: data.replace("sgfinish", "sgdiscard"),
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
    const token = stillGoingCallback(
      "workout",
      withDoses.profileId,
      id,
      "finish"
    );

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
    const token = stillGoingCallback(
      "workout",
      withDoses.profileId,
      id,
      "finish"
    );

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
    const token = stillGoingCallback(
      "workout",
      noDoses.profileId,
      id,
      "finish"
    );

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
    const token = stillGoingCallback(
      "workout",
      noDoses.profileId,
      id,
      "finish"
    );

    await handleCallbackQuery(cq(token, OWN_CHAT));
    expect(endTimeOf(id)).toBeNull(); // not finished
    expect(lastAnswerText()).toContain("Nothing logged yet");
    expect(editTextMock).not.toHaveBeenCalled(); // buttons kept for Discard
  });

  it("refuses a cross-profile token (tapped from a chat that isn't the session's profile)", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = stillGoingCallback(
      "workout",
      withDoses.profileId,
      id,
      "finish"
    );

    // Tapped from OTHER_CHAT (maps only to `other`, not `withDoses`).
    await handleCallbackQuery(cq(token, OTHER_CHAT));
    expect(endTimeOf(id)).toBeNull(); // nothing stamped
    expect(lastAnswerText()).toContain("out of date");
  });
});

describe("renderStillGoingMessage (#1205, one family at #5142)", () => {
  const workout = {
    kind: "workout" as const,
    rowId: 99,
    label: null,
    quietMin: null,
    detectedEnd: null,
  };
  const practice = {
    kind: "practice" as const,
    rowId: 99,
    label: "Sauna",
    quietMin: 95,
    detectedEnd: null,
  };

  it("carries a Finish callback with the row id + the deep-link fallback", () => {
    const msg = renderStillGoingMessage(
      workout,
      7,
      "Ada",
      "https://allos.test/"
    );
    const finish = msg.actions?.find((a) => a.data?.startsWith("sgfinish:"));
    expect(finish?.data).toBe("sgfinish:workout:7:99");
    // The Discard companion carries the same id under its own prefix.
    expect(
      msg.actions?.find((a) => a.data === "sgdiscard:workout:7:99")
    ).toBeTruthy();
    // Non-Telegram channels fall back to the "Open workout" deep-link.
    expect(
      msg.actions?.find((a) => a.url === "https://allos.test/training")
    ).toBeTruthy();
  });

  it("still carries the callback buttons with no deep-link base", () => {
    const msg = renderStillGoingMessage(workout, 7, "Ada", "");
    expect(msg.actions?.some((a) => a.data === "sgfinish:workout:7:99")).toBe(
      true
    );
    expect(msg.actions?.some((a) => a.url)).toBe(false);
  });

  // ONE FAMILY, AND THE KIND IS WHAT DIFFERS. The practice message names the practice
  // and how long it has been running — the person has one live sauna, not a "session"
  // — and its deep-link opens the surface that practice lives on.
  it("names the practice, its quiet, and its own surface", () => {
    const msg = renderStillGoingMessage(
      practice,
      7,
      "Ada",
      "https://allos.test/"
    );
    expect(msg.title).toContain("Still doing Sauna?");
    expect(msg.title).toContain("Ada");
    expect(msg.body).toContain("1h 35m");
    expect(msg.actions?.some((a) => a.data === "sgfinish:practice:7:99")).toBe(
      true
    );
    expect(msg.actions?.some((a) => a.data === "sgdiscard:practice:7:99")).toBe(
      true
    );
    expect(
      msg.actions?.find((a) => a.url === "https://allos.test/wellness")
    ).toBeTruthy();
  });

  // THE PERSON SEES WHAT THEY ARE CONFIRMING (#5194). With a detected end the body
  // quotes the minute, because `finishWorkoutSession` will stamp that minute rather
  // than the tap's own — a person tapping Finish at 18:00 on a session the trace ends
  // at 16:35 must not be surprised by what lands. Without one the copy is unchanged,
  // and the buttons never differ.
  it.each([
    [null, "quiet for a while", "16:35"],
    ["16:35", "ended at 16:35", "quiet for a while"],
  ])("with detectedEnd %s the body says %s", (detectedEnd, says, doesNot) => {
    const body = renderStillGoingMessage(
      { ...workout, detectedEnd },
      7,
      "Ada",
      ""
    ).body;
    expect(body).toContain(says);
    expect(body).not.toContain(doesNot);
  });

  // NEITHER KIND EVER SAYS SOMETHING WAS ENDED (#560). The nudge suggests; the tap
  // writes.
  it("promises no automatic end, whatever the kind", () => {
    for (const episode of [
      workout,
      { ...workout, detectedEnd: "16:35" },
      practice,
    ])
      expect(renderStillGoingMessage(episode, 7, "Ada", "").body).toContain(
        "nothing was ended automatically"
      );
  });
});

describe("Discard button", () => {
  it("deletes the abandoned draft and its sets", async () => {
    const date = today(withDoses.profileId);
    const id = seedLiveDraft(withDoses.profileId, date);
    const token = stillGoingCallback(
      "workout",
      withDoses.profileId,
      id,
      "discard"
    );

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

// ── The practice kind (#5142 AC 3) ───────────────────────────────────────────
//
// The SAME tap, resolved by the kind the token carries. What is worth proving here is
// that it lands in the practice domain's own cores rather than in a second copy of the
// workout ones: Finish ends the live row the way the Wellness card's End button does,
// and Discard deletes it, because a practice row IS the session rather than a draft
// standing in for one.
describe("the practice kind's Finish and Discard (#5142 AC 3)", () => {
  function startPractice(profileId: number): number {
    const started = startLivePracticeSession(profileId, "Sauna", "page");
    expect(started.kind).toBe("started");
    return started.kind === "started" ? started.session.id : -1;
  }

  it("ends the live row through the shared core and says so", async () => {
    const pid = noDoses.profileId;
    const id = startPractice(pid);

    await handleCallbackQuery(
      cq(
        stillGoingCallback("practice", pid, id, "finish"),
        OWN_CHAT,
        "⏱️ Still doing Sauna?"
      )
    );

    expect(lastAnswerText()).toBe("Session finished");
    const [row] = getPracticeSessions(pid, "Sauna");
    expect(row).toMatchObject({ live: 0 });
    expect(row.end_time).not.toBeNull();
  });

  it("deletes the row on Discard — the row IS the session", async () => {
    const pid = noDoses.profileId;
    const id = startPractice(pid);
    const before = getPracticeSessions(pid, "Sauna").length;

    await handleCallbackQuery(
      cq(
        stillGoingCallback("practice", pid, id, "discard"),
        OWN_CHAT,
        "⏱️ Still doing Sauna?"
      )
    );

    expect(lastAnswerText()).toContain("discarded");
    expect(getPracticeSessions(pid, "Sauna").some((r) => r.id === id)).toBe(
      false
    );
    expect(getPracticeSessions(pid, "Sauna").length).toBe(before - 1);
  });

  // OWNERSHIP IS RE-VERIFIED ON THE WRITE, and the token id is only a cross-check. A
  // token tapped from a chat that does not map to this profile writes nothing.
  it("refuses a token tapped from another profile's chat", async () => {
    const pid = noDoses.profileId;
    const id = startPractice(pid);

    await handleCallbackQuery(
      cq(
        stillGoingCallback("practice", pid, id, "finish"),
        OTHER_CHAT,
        "⏱️ Still doing Sauna?"
      )
    );

    expect(lastAnswerText()).toContain("out of date");
    expect(
      getPracticeSessions(pid, "Sauna").find((r) => r.id === id)
    ).toMatchObject({ live: 1, end_time: null });
  });
});
