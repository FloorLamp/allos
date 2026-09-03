// DB INTEGRATION TIER — dispatch() under the shared whole-dispatch deadline
// (#3057), end to end over real channels at the network seam (the
// notify-orchestrators precedent: real isConfigured gates, real marker fold,
// global fetch stubbed — nothing mocked above the wire), on a fake clock so two
// minutes of deadline cost no real time.
//
// What this pins, that the pure tier can't:
//
//   1. a channel whose transport never answers cannot hold dispatch() past
//      NOTIFICATION_DISPATCH_TIMEOUT_MS, and the sibling channel keeps the
//      result it earned — so the caller's channel-agnostic contact rule
//      (`delivered = results.some(ok)`, lib/notifications/tick.ts) stamps the
//      slot marker once on a partial success;
//   2. the timed-out channel is recorded as the delivery-health failure for the
//      OWNER it was addressing (Erroring on that login's row, #2565) with the
//      TYPED timeout error — never as success, never as "nothing configured";
//   3. an all-timeout dispatch reports every channel failed, which leaves the
//      caller's slot marker unset for the ordinary retry band;
//   4. a late completion after the deadline never mutates the returned results —
//      while the OWNER'S ROW follows it (#2565): the row is about the latest
//      completed attempt to that owner, and a late success is one whose message
//      did land, so Erroring-by-timeout gives way to Delivering.
//
// Every value is synthetic: a fake bot token, a fake HA webhook, a fake chat id.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { setTelegramBotConfig, setProfileHomeAssistant } from "@/lib/settings";
import { dispatch, getNotifyError } from "@/lib/notifications";
import { seedLoginTelegram } from "./fixtures";
import {
  DispatchTimeoutError,
  NOTIFICATION_DISPATCH_TIMEOUT_MS,
} from "@/lib/notifications/dispatch-deadline";

const HA_URL = "http://homeassistant.local:8123/api/webhook/allos-deadline";
const CHAT_ID = "7103057";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A fetch stub routing by host: Home Assistant answers 200 at once; Telegram
// accepts the connection and never answers (the stub ignores the request's
// abort signal, so nothing settles it — the shape #3057 is about).
function stubWire(): { resolveTelegram: (body: unknown) => void } {
  let release!: (r: Response) => void;
  const hanging = new Promise<Response>((res) => {
    release = res;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes("api.telegram.org")) return hanging;
      if (target.startsWith(HA_URL)) return new Response(null, { status: 200 });
      throw new Error(`unexpected fetch: ${target}`);
    })
  );
  return {
    resolveTelegram: (body: unknown) =>
      release(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  db.prepare("DELETE FROM notify_lifecycle").run();
  setTelegramBotConfig({
    telegramBotToken: "bot-token-3057",
    telegramMode: "poll",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dispatch() under the shared deadline (#3057)", () => {
  it("partial success: the stuck channel times out typed, the healthy one keeps its result", async () => {
    const wire = stubWire();
    const profileId = createProfile("DeadlinePartial");
    setProfileHomeAssistant(profileId, {
      enabled: true,
      webhookUrl: HA_URL,
      secret: "",
      disabledKinds: [],
    });

    // A managing login's chat is the Telegram OWNER the timeout is recorded against
    // (#2565); an explicit chat override names no login and so no owner.
    seedLoginTelegram(profileId, CHAT_ID);

    let results: Awaited<ReturnType<typeof dispatch>> | null = null;
    void dispatch(profileId, {
      title: "test",
      body: "deadline probe",
      kind: "dose",
    }).then((r) => {
      results = r;
    });

    // HA answers immediately; Telegram holds the whole dispatch until the
    // deadline — one tick shy, it is still pending.
    await vi.advanceTimersByTimeAsync(NOTIFICATION_DISPATCH_TIMEOUT_MS - 1);
    expect(results).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(results).not.toBeNull();

    const telegram = results!.find((r) => r.id === "telegram")!;
    const ha = results!.find((r) => r.id === "home-assistant")!;
    expect(ha).toEqual({ id: "home-assistant", ok: true });
    expect(telegram.ok).toBe(false);
    expect(telegram.timedOut).toBe(true);
    expect(telegram.error).toBe(
      new DispatchTimeoutError("telegram", NOTIFICATION_DISPATCH_TIMEOUT_MS)
        .message
    );

    // The caller's contact rule stamps the slot marker ONCE on any success —
    // a timed-out sibling never blocks that, and is never replayed by it.
    expect(results!.some((r) => r.ok)).toBe(true);

    // The timed-out owner is the recorded delivery-health failure (Erroring),
    // carrying the typed timeout — not "nothing configured", not success.
    const marker = getNotifyError();
    expect(marker).not.toBeNull();
    expect(marker!.channel).toBe("telegram");
    expect(marker!.error).toBe(telegram.error);

    // The send finally answers, long after the results were acted on: the results
    // stand exactly as frozen, and the owner's row reads the outcome that actually
    // happened — the message landed, so the timeout's Erroring gives way.
    wire.resolveTelegram({ ok: true, result: { message_id: 42 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(results!.find((r) => r.id === "telegram")).toBe(telegram);
    expect(telegram.ok).toBe(false);
    await vi.waitFor(() => expect(getNotifyError()).toBeNull());
  });

  it("all channels timed out: every result is a failure, so the slot marker stays unset for the retry band", async () => {
    // Only Telegram is configured, and its transport never answers.
    stubWire();
    const profileId = createProfile("DeadlineAllFail");
    seedLoginTelegram(profileId, CHAT_ID);

    let results: Awaited<ReturnType<typeof dispatch>> | null = null;
    void dispatch(profileId, {
      title: "test",
      body: "deadline probe",
      kind: "dose",
    }).then((r) => {
      results = r;
    });

    await vi.advanceTimersByTimeAsync(NOTIFICATION_DISPATCH_TIMEOUT_MS);
    expect(results).not.toBeNull();
    expect(results!).toHaveLength(1);
    expect(results!.every((r) => !r.ok)).toBe(true);
    expect(results![0].timedOut).toBe(true);
    // `delivered = results.some(ok)` is false, so the tick leaves the slot
    // marker unset and the ordinary attempt band retries — while the failure
    // itself is recorded for the Settings surface.
    expect(results!.some((r) => r.ok)).toBe(false);
    expect(getNotifyError()?.channel).toBe("telegram");
  });
});
