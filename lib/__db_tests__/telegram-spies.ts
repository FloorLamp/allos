// The outbound Telegram primitives, as SHARED spy instances that DELEGATE to the
// real implementation until a spec asks otherwise.
//
// Same shape and the same reason as lib/__action_tests__/cache-spies.ts: the
// `vi.mock` factory in setup-shared.ts re-runs per test file, and under a shared
// module registry fresh `vi.fn()`s would leave already-imported callers holding
// the previous file's spies. Minting them once here and handing the same objects
// back every time is what lets the mock live in a setup file at all — which is
// the point, because a `vi.mock` in a SPEC routes that spec to the isolated
// project (vitest.isolation.ts), and isolated files cost ~10x a shared one.
// Twenty of them carried a copy of this mock purely to stub four functions.
//
// DELEGATING BY DEFAULT IS THE WHOLE DESIGN, and the first attempt got it
// backwards. A tier-wide mock that stubs by default silently changes what every
// OTHER spec tests, and a large class of them — the digest, the notify
// orchestrators, the shared-supply nudge — deliberately drives the real
// primitives against a stubbed global `fetch` and asserts on the wire. Those
// specs never mention telegram-api, so they cannot be found by grepping for it;
// they just start failing. Default-delegate means installing this mock changes
// NOTHING until a spec opts in, and opting in is a plain function call rather
// than a `vi.mock` — so it costs no isolation.
import { vi } from "vitest";

type TelegramApi = typeof import("@/lib/notifications/telegram-api");

// Bound once by the setup factory, which is the only place holding the real
// module. Without it the spies have nothing to delegate to.
let actual: TelegramApi | null = null;

function realOrThrow(): TelegramApi {
  if (!actual) {
    throw new Error(
      "telegram-spies: the real telegram-api was never bound — " +
        "lib/__db_tests__/setup-shared.ts must call bindActualTelegramApi()"
    );
  }
  return actual;
}

export function bindActualTelegramApi(api: TelegramApi): void {
  actual = api;
}

export const sendMessageRaw = vi.fn<TelegramApi["sendMessageRaw"]>((...a) =>
  realOrThrow().sendMessageRaw(...a)
);
export const editMessageTextRaw = vi.fn<TelegramApi["editMessageTextRaw"]>(
  (...a) => realOrThrow().editMessageTextRaw(...a)
);
export const editMessageReplyMarkupRaw = vi.fn<
  TelegramApi["editMessageReplyMarkupRaw"]
>((...a) => realOrThrow().editMessageReplyMarkupRaw(...a));
export const answerCallbackQuery = vi.fn<TelegramApi["answerCallbackQuery"]>(
  (...a) => realOrThrow().answerCallbackQuery(...a)
);

const ALL = [
  sendMessageRaw,
  editMessageTextRaw,
  editMessageReplyMarkupRaw,
  answerCallbackQuery,
] as const;

function delegateAll(): void {
  sendMessageRaw.mockImplementation((...a) =>
    realOrThrow().sendMessageRaw(...a)
  );
  editMessageTextRaw.mockImplementation((...a) =>
    realOrThrow().editMessageTextRaw(...a)
  );
  editMessageReplyMarkupRaw.mockImplementation((...a) =>
    realOrThrow().editMessageReplyMarkupRaw(...a)
  );
  answerCallbackQuery.mockImplementation((...a) =>
    realOrThrow().answerCallbackQuery(...a)
  );
}

// Telegram's own `sendMessage` answers with the new message's id, and callers
// store it to edit or reconcile the message later. A stub that returned nothing
// would let a caller which forgets to persist the id still pass, so the stubbed
// send hands back a fresh id per call.
const FIRST_MESSAGE_ID = 1000;
let nextMessageId = FIRST_MESSAGE_ID;

/**
 * Stop the four primitives from reaching the network, for THIS test file.
 *
 * Call it in a `beforeAll`/`beforeEach` — not at module scope, which runs before
 * the per-file reset in setup-shared.ts and would be undone by it.
 */
export function stubTelegramSends(): void {
  sendMessageRaw.mockImplementation(async () => nextMessageId++);
  editMessageTextRaw.mockImplementation(async () => {});
  editMessageReplyMarkupRaw.mockImplementation(async () => {});
  answerCallbackQuery.mockImplementation(async () => {});
}

/**
 * Return every spy to delegating, per FILE.
 *
 * `mockReset` rather than `mockClear`: a spec that stubbed, or pinned an id with
 * `mockResolvedValue`, would otherwise leave that implementation installed on the
 * shared instance for every later file in the worker — the exact cross-file leak
 * a shared registry makes possible. Reset drops the implementation too, so
 * delegation is reinstalled afterwards.
 */
export function resetTelegramSpies(): void {
  nextMessageId = FIRST_MESSAGE_ID;
  for (const spy of ALL) spy.mockReset();
  delegateAll();
}
