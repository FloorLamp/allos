// WHICH KEYBOARD MINTED THIS BUTTON (#3087) — the chat half of `logged_via`.
//
// THE AXIS. `telegram-nudge` means a tap on a message this app SENT unbidden;
// `telegram-command` means a tap on the on-demand list behind a slash command. That
// distinction is the one #3087 was opened to measure — "does the practice nudge
// actually get used, or does this person log from the dashboard" is unanswerable
// without it — so a handler that guesses is worse than a NULL.
//
// THREE WAYS TO KNOW, AND THIS IS THE THIRD.
//
//   1. THE TOKEN PREFIX DIFFERS. `pdone:` is the pace nudge and `plog:` is the
//      `/practice` list; both run through one handler and one write core, and the
//      prefix carries the answer through the round trip for free. Where the two
//      keyboards already have separate namespaces this is the whole mechanism and
//      nothing here is needed.
//
//   2. THE KEYBOARD'S SHAPE DIFFERS. `prn:` is minted by BOTH the `/dose` list and
//      the digest's "+ Doses" expansion, deliberately, so there is one
//      administration-logging path on Telegram. There the discriminator is the
//      keyboard: an expanded offer list is the only one carrying a collapse token
//      (`isExpandedOfferKeyboard`, in telegram-quick-log.ts).
//
//   3. NEITHER DIFFERS — which is this module. `/food` re-renders `buildFoodNudge`:
//      the same builder, the same `food:` and `foodprotein:` tokens, the same
//      keyboard, byte for byte. Nothing about the delivered message distinguishes a
//      slash-command reply from a proactive send, so the ONLY place that can know is
//      the MINT SITE, and the only way it can tell the handler is to write it into
//      the token.
//
// THE MARKER. One character in a segment of its own, immediately after the family
// prefix: `food:c:<profileId>:<window>:<date>:<slug>`. Placed at the FRONT because
// the slug is the token's greedy tail and anything appended after it would be eaten
// by the slug. One byte, because Telegram caps `callback_data` at 64 and a food token
// already runs to about 45.
//
// EVERY MINT SITE DECLARES. The proactive tick marks `n` and `/food` marks `c` — the
// nudge does not rely on being the default, because a default is exactly what let a
// file-wide literal stamp the wrong answer in the first place. An UNMARKED token is
// only ever a keyboard minted before this shipped; those are read as nudges, which is
// the honest reading of the dominant path, and they age out within the day (a food
// token is date-guarded to its own day and `notify_messages` prunes at three).
//
// EVERY REBUILD PRESERVES. A tap re-renders the whole nudge, so the rebuild re-applies
// the origin it read off the tapped token or the live keyboard. Without that, the
// second tap on a `/food` list would report a nudge — the round trip is where a
// provenance mechanism quietly loses.

import type { LoggedVia } from "../logged-via";
import type { NotificationMessage } from "./types";

/** The two chat surfaces a button can come from. */
export type ChatOrigin = Extract<
  LoggedVia,
  "telegram-nudge" | "telegram-command"
>;

/**
 * The marker character per origin. `Record`, not a list, for the same exhaustiveness
 * reason `LOGGED_VIA_MEANING` is one: a third chat surface is a compile error here
 * rather than a value that silently reads as a nudge.
 */
const MARK: Record<ChatOrigin, string> = {
  "telegram-nudge": "n",
  "telegram-command": "c",
};

/**
 * The reverse map, DERIVED rather than spelled out again.
 *
 * A second hand-kept copy of the charset is a second place to forget it. Adding a
 * third chat surface must be a compile error in `MARK` and a no-op everywhere else.
 */
const BY_MARK = Object.fromEntries(
  Object.entries(MARK).map(([origin, mark]) => [mark, origin])
) as Record<string, ChatOrigin>;

/**
 * The marker charset as a regex character class, derived from `MARK`.
 *
 * THE CHARSET IS WRITTEN ONCE (#3567 item 3). It used to be hand-spelled `[nc]` at
 * six code sites across three modules — here, in `food-format.ts`'s button counter
 * and in `food-nudge-pointer.ts` — and every one of them was correct only by
 * coincidence. Widening the charset would have missed most of them SILENTLY: a food
 * token whose marker no longer matches does not throw, it reads as an unmarked legacy
 * token, which is a valid state that logs a nudge. So the class comes from the
 * exhaustive record above, and the census in lib/__tests__/chat-origin.test.ts holds
 * the tree to it.
 *
 * The marks are single ASCII letters from a closed vocabulary, so they need no
 * character-class escaping — pinned by that same census.
 */
const MARK_CLASS = `[${Object.values(MARK).join("")}]`;

/**
 * The marker segment at the head of a token's tail, with the mark captured.
 *
 * Used for both reading (`.exec(…)?.[1]`) and stripping (`.replace(…, "")`), so the
 * two directions cannot drift apart. No `g` flag: a shared regex with one would carry
 * `lastIndex` between calls.
 */
const LEADING_MARK_RE = new RegExp(`^(${MARK_CLASS}):`);

/**
 * How an unmarked token reads.
 *
 * NOT a convenience default for new code — every mint site marks. This is the
 * legacy answer for a keyboard already on someone's screen when this shipped, and
 * the proactive nudge is what almost all of those are.
 */
export const UNMARKED_CHAT_ORIGIN: ChatOrigin = "telegram-nudge";

/**
 * The token families that carry a marker.
 *
 * Declared rather than "every token": rewriting a prefix nothing parses back would
 * produce a button whose tap is silently refused, which is a worse bug than the one
 * this fixes. These two are exactly the families `buildFoodNudge` mints and
 * `parseFoodLogCallback` / `parseFoodProteinCallback` read.
 */
const MARKED_PREFIXES = ["foodprotein", "food"] as const;

/** The regex fragment a family parser uses for its optional marker segment. */
export const ORIGIN_MARK_PATTERN = `(?:(${MARK_CLASS}):)?`;

/** Read a marker back, defaulting to the legacy reading. */
export function originFromMark(mark: string | undefined): ChatOrigin {
  return (mark && BY_MARK[mark]) || UNMARKED_CHAT_ORIGIN;
}

/**
 * Write the marker into one callback token, replacing any marker already there.
 *
 * A token whose family carries no marker is returned untouched, so this is safe to
 * run over a whole keyboard.
 */
export function markToken(data: string, origin: ChatOrigin): string {
  for (const prefix of MARKED_PREFIXES) {
    if (!data.startsWith(`${prefix}:`)) continue;
    const rest = data.slice(prefix.length + 1).replace(LEADING_MARK_RE, "");
    return `${prefix}:${MARK[origin]}:${rest}`;
  }
  return data;
}

/** Read the origin off ONE token, whatever family it belongs to. */
export function originFromToken(data: unknown): ChatOrigin {
  if (typeof data !== "string") return UNMARKED_CHAT_ORIGIN;
  for (const prefix of MARKED_PREFIXES) {
    if (!data.startsWith(`${prefix}:`)) continue;
    return originFromMark(
      LEADING_MARK_RE.exec(data.slice(prefix.length + 1))?.[1]
    );
  }
  return UNMARKED_CHAT_ORIGIN;
}

/**
 * The origin a LIVE keyboard DECLARES, or `null` when it declares nothing.
 *
 * The first marked button wins: one message is one send, so its buttons cannot
 * honestly disagree.
 *
 * NULL RATHER THAN THE LEGACY DEFAULT, and the difference is load-bearing for the
 * hourly reconcile sweep. A rebuild's job is to preserve what the delivered keyboard
 * says; a keyboard minted before this shipped says nothing, so the rebuild must say
 * nothing too. Answering `telegram-nudge` here instead would make every rebuild of a
 * legacy nudge differ from the keyboard already on screen by exactly the marker, and
 * the sweep — which edits only when the render differs — would spend one Telegram
 * edit per live food message to add it. Two `message-reconcile` tests caught precisely
 * that. The legacy READING still happens, but at the tap, where a value is actually
 * needed (`originFromToken`).
 */
export function keyboardChatOrigin(
  rows: readonly (readonly { callback_data?: string }[])[] | undefined
): ChatOrigin | null {
  for (const row of rows ?? []) {
    for (const btn of row) {
      if (typeof btn.callback_data !== "string") continue;
      for (const prefix of MARKED_PREFIXES) {
        if (!btn.callback_data.startsWith(`${prefix}:`)) continue;
        const mark = LEADING_MARK_RE.exec(
          btn.callback_data.slice(prefix.length + 1)
        )?.[1];
        if (mark) return originFromMark(mark);
      }
    }
  }
  return null;
}

/**
 * Stamp a built message's whole keyboard with the surface that is about to send or
 * re-send it.
 *
 * Three things pass straight through unchanged: a `null` message (a builder's
 * "nothing to show"), a message with no actions, and a `null` origin — which is a
 * rebuild of a keyboard that declared nothing, and must stay that way rather than
 * acquiring a marker the delivered message never had.
 */
export function withChatOrigin<T extends NotificationMessage | null>(
  message: T,
  origin: ChatOrigin | null
): T {
  if (!origin || !message?.actions) return message;
  return {
    ...message,
    actions: message.actions.map((action) =>
      action.data ? { ...action, data: markToken(action.data, origin) } : action
    ),
  } as T;
}
