// THE TELEGRAM COMMAND VOCABULARY — issue #1895, the PURE half.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The bot understood three commands (`/dose`, `/symptom`, `/temp`) and every handler
// no-opped on non-matching text, so nothing ever answered anything else. `/start` — the
// FIRST thing Telegram shows a new user, before they have typed a word — vanished.
// `/help` vanished. A typo'd `/doze` vanished. From the chat's side the bot was
// indistinguishable from broken, and the only way to learn a verb was to be told one
// out of band.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────
//
// A slash command in a chat the bot is in gets an answer. Always. Either the command's
// own reply, or a short pointer at `/help`. Silence is never the answer, because silence
// is the failure mode the user cannot distinguish from an outage.
//
// ── REGISTRATION IS INSTANCE-LEVEL, RELEVANCE IS PER-CHAT ────────────────────
//
// `setMyCommands` registers ONE list for the whole bot — Telegram's `/` autocomplete
// menu has no per-chat variant that a self-hosted instance can maintain cheaply. So the
// registered list stays GENERIC (every verb the build ships) and the handlers keep
// owning per-chat gating, exactly as they do today. `/help` is the per-chat-honest
// answer: it names only what THIS chat's profiles can actually do, and a gated command
// typed anyway gets a quiet explanation rather than a wrong-shaped reply.
//
// No DB, no network, no clock here: relevance arrives as facts, so every list and every
// reply is fixture-testable.

// Which facts about a chat decide whether a verb is offered. Resolved once, at the DB
// boundary, and passed in — so the gate cannot drift between `/help` and the handler
// that answers the command.
export interface ChatCommandContext {
  // The chat maps to at least one profile. Nothing is offered without this: an
  // unlinked chat has no data subject to act for.
  linked: boolean;
  // The daily wellbeing check-in is enabled for at least one of the chat's profiles.
  moodCheckin: boolean;
}

export interface TelegramCommand {
  // The verb, without its slash.
  name: string;
  // The one-line description Telegram shows in the `/` menu and `/help` repeats.
  // Telegram caps these at 256 chars; the copy standard (#945) caps them far shorter.
  description: string;
  // Is this verb offered in a chat with these facts? Absent ⇒ offered whenever the
  // chat is linked at all.
  relevant?: (ctx: ChatCommandContext) => boolean;
  // Verbs that route to the same handler (`/symptoms`, `/temperature`). Registered
  // with Telegram only under `name`, so the `/` menu stays one row per verb.
  aliases?: readonly string[];
  // Answerable in an UNLINKED chat. Only the two meta-verbs are: they are how someone
  // whose chat isn't wired up yet finds out that it isn't.
  worksUnlinked?: boolean;
}

export const TELEGRAM_COMMANDS: readonly TelegramCommand[] = [
  {
    name: "help",
    description: "What this bot can do here",
    worksUnlinked: true,
  },
  {
    name: "start",
    description: "Get started",
    worksUnlinked: true,
  },
  {
    name: "dose",
    description: "Log an as-needed medication",
  },
  {
    name: "symptom",
    description: "Log a symptom",
    aliases: ["symptoms"],
  },
  {
    name: "temp",
    description: "Log a temperature",
    aliases: ["temperature"],
  },
  {
    name: "mood",
    description: "Check in on how you are",
    relevant: (ctx) => ctx.moodCheckin,
  },
];

// The list Telegram's `/` menu is registered with — GENERIC by design (see the header).
// Ordered as declared, so `/help` leads.
export function registrableCommands(): {
  command: string;
  description: string;
}[] {
  return TELEGRAM_COMMANDS.map((c) => ({
    command: c.name,
    description: c.description,
  }));
}

// The verbs THIS chat can actually use. The per-chat-honest list `/help` prints and the
// gate each handler re-checks — one function, so the two can't disagree.
export function commandsForChat(
  ctx: ChatCommandContext
): readonly TelegramCommand[] {
  return TELEGRAM_COMMANDS.filter((c) => {
    if (!ctx.linked) return c.worksUnlinked === true;
    return c.relevant ? c.relevant(ctx) : true;
  });
}

export function isCommandAvailable(
  name: string,
  ctx: ChatCommandContext
): boolean {
  return commandsForChat(ctx).some((c) => c.name === name);
}

// ---- Parsing ---------------------------------------------------------------

export interface ParsedCommand {
  // The canonical verb (an alias resolves to the command it belongs to), lowercased.
  // Null for a slash-word that matches nothing the build ships.
  name: string | null;
  // Exactly what was typed, minus the slash and any @botname, lowercased. What the
  // unknown-command reply echoes back, so a typo is visible as a typo.
  typed: string;
  // Everything after the verb, trimmed. Unused by every command today (all of them
  // answer with a keyboard or a prompt), kept so a future verb need not re-parse.
  args: string;
}

const ALIAS_TO_NAME = new Map<string, string>(
  TELEGRAM_COMMANDS.flatMap((c) => [
    [c.name, c.name] as [string, string],
    ...(c.aliases ?? []).map((a) => [a, c.name] as [string, string]),
  ])
);

// Parse a message body as a slash command. Null when the text is not a command at all
// — which is the ONLY case the dispatcher may leave unanswered, because ordinary chat
// in a group the bot sits in is not addressed to it.
//
// Telegram appends `@botname` to commands typed in a GROUP, so `/dose@allosbot` and
// `/dose` are the same verb. The bot name is not checked against this instance's own:
// a chat with two bots would then get silence from the one it addressed, which is the
// defect this module exists to remove. Answering a command aimed elsewhere costs one
// message; staying silent costs the user's trust that the bot works at all.
export function parseCommand(
  text: string | undefined | null
): ParsedCommand | null {
  const trimmed = (text ?? "").trim();
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
    trimmed
  );
  if (!m) return null;
  const typed = m[1].toLowerCase();
  return {
    name: ALIAS_TO_NAME.get(typed) ?? null,
    typed,
    args: (m[2] ?? "").trim(),
  };
}

// Does this message text trigger `name`? THE authority on the question — issue #2004.
//
// The dispatcher resolves a verb once, through `parseCommand`, and routes on the
// result. But each logging handler ALSO re-checked the raw text against a hand-written
// regex of its own (`/^\/dose(@\w+)?(\s|$)/i` and friends), so "which text triggers
// this handler" had two independent answers that were kept in step by hand. An alias
// added here without the matching regex edit there would have reproduced exactly the
// silence #1895 exists to eliminate: the dispatcher routes, the availability gate says
// the verb exists, and the handler's private regex declines — zero replies, which from
// the chat's side is indistinguishable from an outage.
//
// So the guard is DERIVED, not duplicated: it asks the same parser the dispatcher asks
// and compares the canonical name. Aliases, `@botname` addressing, case and trailing
// args are therefore whatever `parseCommand` says they are, once, forever. A handler
// called directly (a test, a future second entry point) keeps its guard; what it loses
// is a second opinion about the vocabulary.
export function isCommandText(
  name: string,
  text: string | null | undefined
): boolean {
  return parseCommand(text)?.name === name;
}

// ---- Replies ---------------------------------------------------------------

// The copy rules (#1819/#1822): short, named verbs, no jargon, no exclamation.
export const HELP_TITLE = "What I can do here";
export const START_TITLE = "Allos";

// `/help`'s body — the per-chat-honest list. Never the registered list: a chat whose
// check-in is off must not be told about `/mood`, or the verbs that would have helped
// are buried under one that cannot work.
export function helpBody(ctx: ChatCommandContext): string {
  const commands = commandsForChat(ctx).filter(
    (c) => c.name !== "help" && c.name !== "start"
  );
  if (!ctx.linked) return UNLINKED_BODY;
  if (commands.length === 0) {
    // Structurally reachable (a chat whose every logging verb is gated off), so it gets
    // a real sentence rather than an empty list.
    return "This chat is linked, but none of the logging commands apply to it yet. Everything is still available in the app.";
  }
  return commands.map((c) => `/${c.name} — ${c.description}`).join("\n");
}

// `/start` is the first thing Telegram shows a new user, before they have typed
// anything. It says what this is and hands straight over to the verb list, because a
// greeting that does not tell you what to type next is the same silence one step later.
export function startBody(ctx: ChatCommandContext): string {
  if (!ctx.linked) return UNLINKED_BODY;
  return `Quick logging for your health data, from this chat.\n\n${helpBody(ctx)}`;
}

export const UNLINKED_BODY =
  "This chat isn't linked to a profile yet — enable Telegram in Settings → Notifications, then send /help here.";

// The unknown-command fallback. Echoes what was typed so a typo reads as a typo, and
// points at the one verb that lists the rest.
export function unknownCommandBody(typed: string): string {
  return `I don't know /${typed}. Send /help to see what works here.`;
}

// A command that EXISTS but is gated off for this chat. Distinct from unknown on
// purpose: "not for this chat" and "not a thing" are different answers, and conflating
// them sends someone hunting for a typo that isn't there.
export function unavailableCommandBody(name: string): string {
  const entry = TELEGRAM_COMMANDS.find((c) => c.name === name);
  const what = entry ? entry.description.toLowerCase() : name;
  return `/${name} (${what}) isn't set up for this chat. Send /help to see what is.`;
}
