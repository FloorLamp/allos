// THE COMMAND VOCABULARY — DB half (issue #1895).
//
// Resolves one chat's ChatCommandContext (the facts the pure gate in
// ./telegram-commands reads) and answers the two META verbs plus the unknown-command
// fallback. The verbs that LOG something live with their own domain in
// ./telegram-quick-log; what lives here is the part that makes the vocabulary
// discoverable at all.
//
// ONE GATE, TWO READERS. `/help` prints exactly the verbs `commandsForChat` allows and
// each handler re-checks the same predicate, so the list can never advertise something
// that then refuses — the failure mode that makes a help text worse than none.
//
// Everything sends through the chokepoint's `sendTelegramMessage`, like every other
// command reply.

import {
  getProfileMoodCheckin,
  getProfilesByTelegramChatId,
} from "../settings";
import {
  HELP_TITLE,
  START_TITLE,
  commandsForChat,
  helpBody,
  isCommandAvailable,
  startBody,
  unavailableCommandBody,
  unknownCommandBody,
  type ChatCommandContext,
} from "./telegram-commands";
import { sendTelegramMessage } from "./telegram";

// The chat's facts. A relevance bit is TRUE when it holds for AT LEAST ONE of the
// chat's profiles: a family chat where one member runs the check-in and another does
// not still needs `/mood` offered — the command renders per-profile buttons, and the
// per-profile gate inside the builder is what keeps the other member out of it.
export function chatCommandContext(
  chatId: string | number
): ChatCommandContext {
  const profileIds = getProfilesByTelegramChatId(String(chatId));
  return {
    linked: profileIds.length > 0,
    moodCheckin: profileIds.some((pid) => getProfileMoodCheckin(pid)),
  };
}

// `/help` — the per-chat-honest verb list. Never the registered list (which is
// instance-wide by necessity): a chat is told what IT can do.
export async function sendHelp(
  chatId: string | number,
  ctx: ChatCommandContext
): Promise<void> {
  await sendTelegramMessage(chatId, {
    title: HELP_TITLE,
    body: helpBody(ctx),
  });
}

// `/start` — the first thing Telegram shows a new user, before they have typed
// anything. It used to vanish entirely, which is the worst possible first impression:
// indistinguishable from a broken bot.
export async function sendStart(
  chatId: string | number,
  ctx: ChatCommandContext
): Promise<void> {
  await sendTelegramMessage(chatId, {
    title: START_TITLE,
    body: startBody(ctx),
  });
}

// A command this build ships but this chat cannot use. Answered DIFFERENTLY from an
// unknown verb on purpose: "not set up here" and "not a thing" send the user looking in
// two different places, and conflating them sends them hunting for a typo that isn't
// there.
export async function sendUnavailable(
  chatId: string | number,
  name: string
): Promise<void> {
  await sendTelegramMessage(chatId, {
    title: HELP_TITLE,
    body: unavailableCommandBody(name),
  });
}

// The unknown-command fallback. THE rule this issue exists for: a slash command in a
// chat the bot is in gets an answer, always — silence is the one failure the user
// cannot distinguish from an outage.
export async function sendUnknownCommand(
  chatId: string | number,
  typed: string
): Promise<void> {
  await sendTelegramMessage(chatId, {
    title: HELP_TITLE,
    body: unknownCommandBody(typed),
  });
}

// Re-exported so the dispatcher reads one import for the whole vocabulary.
export { commandsForChat, isCommandAvailable };
export type { ChatCommandContext };
