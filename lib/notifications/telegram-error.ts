// Telegram Bot API FAILURE CLASSIFICATION (issue #1885).
//
// Two things live here, and nothing else: the typed error the raw transport throws,
// and the ONE pure decision that says what a failed call MEANS. Pure by construction —
// no fetch, no DB — so it is unit-tested in lib/__tests__/telegram-error.test.ts and
// every caller reads the same answer.
//
// WHY IT EXISTS. `call()` in ./telegram-api used to throw a bare `Error` for every
// failure mode alike: a 429 rate limit, a transient 5xx, a DNS blip, an AbortSignal
// timeout, a missing bot token, and "message to edit not found" were indistinguishable
// strings. The reconcile sweep (./reconcile.ts) then treated ALL of them as proof the
// message was dead and dropped its pointer — and because the sweep claims the pointer
// BEFORE the network call (#1788), a dropped pointer has no retry path left. One
// transient blip therefore left a live chat showing a stale keyboard that no future
// tick could ever correct.
//
// THE SPLIT.
//   permanent — the message is unreachable FOREVER: deleted, past Telegram's edit
//               horizon, chat gone, bot removed or blocked. Retrying is pure waste, so
//               the caller may forget the pointer.
//   transient — this ATTEMPT did not land: rate limit, 5xx, network reach failure,
//               timeout, unconfigured token. The message is still there, so the caller
//               must keep whatever state a later attempt needs.

// The classes a failed Bot API call can fall into. Deliberately two — a caller only
// ever has two behaviours available (forget it, or keep it for later).
export type TelegramFailureClass = "permanent" | "transient";

// The transport's typed throw. Carries the HTTP status and Telegram's own
// `description` so classification reads STRUCTURE rather than a formatted sentence.
// `status` is null when the request never received a response at all (DNS failure,
// refused connection, AbortSignal.timeout) — which is itself the transient signature.
export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number | null;
  readonly description: string | null;

  constructor(init: {
    method: string;
    status: number | null;
    description: string | null;
    message: string;
    cause?: unknown;
  }) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause }
    );
    this.name = "TelegramApiError";
    this.method = init.method;
    this.status = init.status;
    this.description = init.description;
  }
}

// Telegram's descriptions for a message that can never be edited again. Matched
// case-insensitively against the typed `description` when there is one, and against the
// error's message text otherwise — a mocked transport, and any older call site that
// still throws a plain Error, both surface the description INSIDE the message string
// (`Telegram editMessageText failed: message to edit not found`), so one list covers
// both shapes.
//
// Every entry names a state the app cannot change and that will not change on its own
// within a pointer's ~48h edit horizon: the message is gone, too old, or the bot has
// lost the chat entirely.
const PERMANENT_DESCRIPTIONS: readonly RegExp[] = [
  /message to edit not found/i,
  /message can'?t be edited/i,
  /message_id_invalid/i,
  /chat not found/i,
  /bot was kicked/i,
  /bot was blocked/i,
  /bot is not a member/i,
  /user is deactivated/i,
  /chat_write_forbidden/i,
  /peer_id_invalid/i,
  // The chat id itself changed; the old message is unreachable at the id we hold.
  /group chat was upgraded to a supergroup/i,
];

// The text to pattern-match: the structured description when the transport typed the
// throw, otherwise the raw message (mock/legacy shape).
function failureText(e: unknown): string {
  if (e instanceof TelegramApiError) return e.description ?? e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// The HTTP status, read from the typed error when present and otherwise recovered from
// the transport's own `HTTP <n>` message tail — the format `call()` uses when Telegram
// answered without a description.
function statusOf(e: unknown): number | null {
  if (e instanceof TelegramApiError) return e.status;
  const m = /\bHTTP (\d{3})\b/.exec(failureText(e));
  return m ? Number(m[1]) : null;
}

// Is this failed Bot API call proof the message is gone for good?
//
// THE DEFAULT IS TRANSIENT, and it is deliberate. An unrecognised failure is far more
// likely to be a new Telegram-side or network-side condition than a new flavour of
// "this message no longer exists", and the two mistakes are not symmetric:
//
//   • wrongly PERMANENT drops the pointer, and with the claim-first design there is no
//     retry path left — a live chat keeps a lying keyboard forever;
//   • wrongly TRANSIENT retries an already-dead message at most once per tick until
//     `pruneMessagePointers` removes the row at MESSAGE_POINTER_RETENTION_DAYS.
//
// That prune is the BOUND: retries are capped by the pointer's own retention horizon
// (hourly ticks over 3 days ≈ 72 cheap, fast-failing calls), so "transient" can never
// mean "retry forever" and needs no attempt counter of its own.
export function classifyTelegramFailure(e: unknown): TelegramFailureClass {
  if (PERMANENT_DESCRIPTIONS.some((re) => re.test(failureText(e))))
    return "permanent";
  // 403 Forbidden is Telegram's answer for a chat the bot can no longer write to at
  // all (blocked, kicked, removed from the group) — permanent even when the
  // description is one we do not recognise.
  if (statusOf(e) === 403) return "permanent";
  return "transient";
}
