// SHARED Telegram-failure fixtures (#2827): the four failure shapes every
// pointer-retention decision must classify the same way — a deleted message
// (permanent), a timeout and a rate limit (transient), and an unrecognised
// error (the classifier's conservative transient default).
//
// One list, consumed by BOTH strip paths' specs — the #947/#1719 rotation
// (food-rotation-claim.test.ts) and the #1898 supersede close
// (kind-supersede.test.ts) — so "there is one failure classifier and one
// pointer-retention interpretation" is a property the fixtures themselves
// enforce: a path that grew its own string matching would diverge on exactly
// these cases. The classifier's own unit matrix stays in
// lib/__tests__/telegram-error.test.ts; this list is the cross-path contract,
// not a second copy of it.

import { TelegramApiError } from "@/lib/notifications/telegram-error";
import type { TelegramFailureClass } from "@/lib/notifications/telegram-error";

export interface TelegramFailureFixture {
  name: string;
  classified: TelegramFailureClass;
  make: () => Error;
}

export const TELEGRAM_FAILURE_FIXTURES: readonly TelegramFailureFixture[] = [
  {
    // The message is gone for good: retrying is pure waste, the pointer is
    // retired in the same call.
    name: "deleted message",
    classified: "permanent",
    make: () => new Error("Bad Request: message to edit not found"),
  },
  {
    // The request never got an answer — the typed transport throw with a null
    // status, which is itself the transient signature.
    name: "timeout",
    classified: "transient",
    make: () =>
      new TelegramApiError({
        method: "editMessageReplyMarkup",
        status: null,
        description: null,
        message: "Telegram editMessageReplyMarkup failed: request timed out",
      }),
  },
  {
    // This ATTEMPT was refused; the message is still there.
    name: "rate limit",
    classified: "transient",
    make: () =>
      new TelegramApiError({
        method: "editMessageReplyMarkup",
        status: 429,
        description: "Too Many Requests: retry after 3",
        message:
          "Telegram editMessageReplyMarkup failed: Too Many Requests: retry after 3",
      }),
  },
  {
    // Unrecognised ⇒ the conservative branch: keep the pointer, retry bounded
    // by its own retention horizon.
    name: "unknown error",
    classified: "transient",
    make: () => new Error("an entirely novel failure nobody classified"),
  },
];
