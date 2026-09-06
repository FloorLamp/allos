// DB INTEGRATION TIER — the kind × channel matrix ENFORCEMENT at each channel's
// dispatch seam (#928). Proves what the pure gate can't: a kind a user disabled for
// a channel is a DELIBERATE non-send at that channel's send site — no throw, so
// dispatch() counts the channel healthy and never sets notify_last_error. Covers the
// two new columns: Telegram (profile-scoped, gated inside the chokepoint) and Web
// Push (login-scoped, gated per-subscription by its owning login).
//
// And what the TICK does with those two answers (#5194, eleventh pass), because the
// slot dedup is where a wrong reading of them is felt: a healthy filtered send must
// burn the day's slot, and a failed-but-partly-delivered send must not.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import {
  setSetting,
  setLoginTelegram,
  setLoginTelegramDisabledKinds,
  setLoginPushDisabledKinds,
} from "@/lib/settings";
import {
  ensureVapidKeys,
  savePushSubscription,
} from "@/lib/notifications/push";
import { dispatch, getNotifyError } from "@/lib/notifications";
import { getProfileSetting } from "@/lib/settings";
import { runTickSlot } from "@/lib/notifications/tick";
import { TICK_SLOT_MARKER_KEYS } from "@/lib/notifications/send-markers";
import type { NotificationMessage } from "@/lib/notifications/types";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newLogin(role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`u${Math.random().toString(36).slice(2)}`, role).lastInsertRowid
  );
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(loginId, profileId);
}

const REFILL: NotificationMessage = {
  title: "Refill soon",
  body: "Vitamin D is running low",
  kind: "refill",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // A Telegram send hits fetch — mock a valid Telegram OK so an ENABLED kind would
  // succeed (proving a DISABLED kind never even reaches fetch).
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  // The delivery-health marker is now the notify_lifecycle row (issue #942), not the
  // legacy notify_last_error* settings keys — reset both so a prior case cannot leak.
  db.prepare("DELETE FROM notify_lifecycle").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'notify_last_error%'").run();
});

afterEach(() => vi.unstubAllGlobals());

describe("Telegram column gate (chokepoint)", () => {
  it("a disabled kind is a silent non-send — no fetch, no marker", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tg-gate");
    // #1072: the Telegram channel is login-scoped — a MANAGING login carries the
    // chat and the disabled-kinds gate.
    const l = newLogin("member");
    grant(l, p);
    setLoginTelegram(l, { telegramEnabled: true, telegramChatId: "123" });
    setLoginTelegramDisabledKinds(l, ["refill"]);

    const results = await dispatch(p, REFILL);
    // Telegram is the only configured channel; the send short-circuited. HEALTHY AND
    // DELIVERED TO NOBODY, which are two different facts (#5194, tenth pass): a
    // filtered audience must never read as a message somebody received.
    expect(results).toEqual([{ id: "telegram", ok: true, delivered: false }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getNotifyError()).toBeNull();
  });

  it("an enabled kind DOES reach the Telegram send site", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tg-enabled");
    const l = newLogin("member");
    grant(l, p);
    setLoginTelegram(l, { telegramEnabled: true, telegramChatId: "123" });
    setLoginTelegramDisabledKinds(l, ["digest"]); // refill still on

    const results = await dispatch(p, REFILL);
    expect(results).toEqual([{ id: "telegram", ok: true, delivered: true }]);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("Web Push column gate (per owning login)", () => {
  it("filters out a subscription whose login disabled the kind — no marker", async () => {
    ensureVapidKeys();
    const p = newProfile("push-gate");
    const member = newLogin("member");
    grant(member, p);
    // A real-looking but unreachable endpoint: if the gate FAILED to filter it, the
    // web-push send would error and set the marker — so ok + null marker proves the
    // filter ran.
    savePushSubscription(member, {
      endpoint: "https://push.example.com/sub-gate",
      p256dh:
        "BObSAMPLEp256dhKEYvaluethatislongenoughxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      auth: "authsecretvalue",
    });
    setLoginPushDisabledKinds(member, ["refill"]);

    const results = await dispatch(p, REFILL);
    // Every subscription filtered out: healthy, and nobody was reached.
    expect(results).toEqual([{ id: "push", ok: true, delivered: false }]);
    expect(getNotifyError()).toBeNull();
  });
});

// THE TICK'S SLOT DEDUP READS THE CHANNEL'S ANSWER, NOT THE RECIPIENT'S (#5194,
// eleventh falsifying pass). `dispatch` now answers two questions — `ok`, did the
// channel finish, and `delivered`, did anybody receive it — and `lib/notifications/tick.ts`
// says in as many words that its slot marker keeps reading `ok`. Nothing held that
// sentence: swapping the reading passed every notification suite in the tree, while the
// swap would change the retry band of every reminder the tick sends, the safety tier
// included. These two cases are the sentence.
//
// The message is a practice nudge (a real toggleable kind on a real tick slot) and the
// runner is the production `runTickSlot`, so the marker discipline cannot drift away
// from the tick.
const PRACTICE: NotificationMessage = {
  title: "Practice check-in",
  body: "Stretching is behind its weekly floor",
  kind: "practice",
};
const PRACTICE_MARKER = TICK_SLOT_MARKER_KEYS.practice;
const DAY = "2026-07-17";

describe("the tick's slot dedup reads `ok`, deliberately", () => {
  it("burns the day's slot for a filtered audience — healthy, nobody reached, asked once", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tick-filtered");
    const l = newLogin("member");
    grant(l, p);
    setLoginTelegram(l, { telegramEnabled: true, telegramChatId: "555" });
    setLoginTelegramDisabledKinds(l, ["practice"]);

    let builds = 0;
    const build = () => {
      builds++;
      return PRACTICE;
    };

    expect(await runTickSlot(p, "practice", PRACTICE_MARKER, DAY, build)).toBe(
      "sent"
    );
    // The control on WHY this is the interesting case: the channel was healthy and it
    // reached nobody, which is the pair the two gate cases above pin at the seam.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getProfileSetting(p, PRACTICE_MARKER)).toBe(DAY);
    // The point of the marker: the person turned this kind off, so the hour after must
    // not ask again. Reading `delivered` here would re-evaluate and re-send-attempt
    // this slot every hour for the rest of the day.
    expect(await runTickSlot(p, "practice", PRACTICE_MARKER, DAY, build)).toBe(
      "already-sent"
    );
    expect(builds).toBe(1);
  });

  it("leaves the slot open for a partly delivered household — failed channel, somebody reached", async () => {
    setSetting("telegram_bot_token", "test-token");
    const p = newProfile("tick-household");
    // The good chat sorts first (older login), so the fan-out reaches it before the
    // blocked one throws — the shape that makes `ok` and `delivered` disagree.
    const good = newLogin("member");
    grant(good, p);
    setLoginTelegram(good, {
      telegramEnabled: true,
      telegramChatId: "chat-good",
    });
    const blocked = newLogin("member");
    grant(blocked, p);
    setLoginTelegram(blocked, {
      telegramEnabled: true,
      telegramChatId: "chat-blocked",
    });
    fetchMock.mockImplementation(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        String(init?.body ?? "").includes("chat-blocked")
          ? new Response(
              JSON.stringify({
                ok: false,
                description: "Forbidden: bot was blocked by the user",
              }),
              { status: 403, headers: { "content-type": "application/json" } }
            )
          : new Response(
              JSON.stringify({ ok: true, result: { message_id: 3 } }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            )
    );

    expect(
      await runTickSlot(p, "practice", PRACTICE_MARKER, DAY, () => PRACTICE)
    ).toBe("failed");
    // The control on "somebody reached": both chats were attempted and the good one
    // took the message, so `delivered` is true for this send while `ok` is false.
    const bodies = fetchMock.mock.calls.map((c) =>
      String((c[1] as RequestInit | undefined)?.body ?? "")
    );
    expect(bodies.some((b) => b.includes("chat-good"))).toBe(true);
    expect(bodies.some((b) => b.includes("chat-blocked"))).toBe(true);
    // NOT marked: the household's other chat never got this, and the slot's shared
    // attempt band is what retries for it next hour. This is the reading tick.ts keeps.
    expect(getProfileSetting(p, PRACTICE_MARKER)).toBeUndefined();
    expect(
      await runTickSlot(p, "practice", PRACTICE_MARKER, DAY, () => PRACTICE)
    ).toBe("failed");
  });
});
