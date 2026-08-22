// WHICH SURFACE A PERSON LOGGED FROM (#3087) — the closed vocabulary behind the
// `logged_via` column every user-write ledger in the first tranche now carries.
//
// WHY A COLUMN AND NOT A LINK. The one thing in this app that looked like
// provenance is `notify_message_id` (#2264), and it is not: it binds a
// time-correction row to the message that produced it, against a table pruned on a
// 3-day retention and declared `ON DELETE SET NULL`. It is DESIGNED to evaporate,
// so it can answer "which keyboard is live" and can never answer "how does this
// person log". That is the whole lesson this module encodes:
//
//   * a plain TEXT column, never a foreign key into anything with a retention or
//     reconcile lifecycle;
//   * closed vocabulary, so the values stay comparable across years;
//   * written at CREATION and never rewritten by an edit (`practice_logs.edited`
//     already carries "this was touched later");
//   * ORTHOGONAL to `source`. Both columns stay. `source` answers "which importer
//     or integration produced this row"; `logged_via` answers "which surface a
//     person used". `import` is the single value where `source` is the
//     authoritative half and this column merely says so.
//
// WHAT IT IS FOR, AND THE BOUND ON THAT. The #3077 relevance ranker's engagement
// axis is the consumer (deliberately a separate issue — a storage bug must not be
// able to hide behind a ranking argument). The standing guardrail governs every
// use: **provenance may reduce or reorder what the app shows, never increase
// contact.** Knowing somebody ignores a nudge is grounds for sending it LESS. It is
// never grounds for sending more, and never for a new "you never use this" message.
// Nothing here leaves the instance and nothing here adds a field to an outbound
// message.

/**
 * The closed vocabulary. Every value is a SURFACE A PERSON ACTED ON, except
 * `import`, which states that no person acted at all.
 *
 * Adding a value is a deliberate act: extend this union and the meaning record
 * below in the same change (the record is exhaustive, so the compiler insists).
 */
export type LoggedVia =
  | "telegram-nudge"
  | "telegram-command"
  | "telegram-text"
  | "dashboard-hero"
  | "dashboard-widget"
  | "quick-log"
  | "page"
  | "offline-replay"
  | "import";

/**
 * What each value means, in the words a reader of a query result needs.
 *
 * THE RECORD IS THE REGISTRY, and the array below is derived from it — never the
 * other way round. A `const values: LoggedVia[] = [...]` list accepts a SUBSET, so
 * adding a tenth member would leave every guard written over that list green while
 * silently not covering the new value. `Record<LoggedVia, string>` is exhaustive in
 * both directions: a missing key and a stray key are both compile errors.
 */
export const LOGGED_VIA_MEANING: Record<LoggedVia, string> = {
  "telegram-nudge": "tapped a button on a proactive send",
  "telegram-command":
    "the on-demand list behind a slash command (/practice, /food, /dose)",
  "telegram-text": "free-text intake typed into the chat (#877)",
  "dashboard-hero": "a confirm on the attention card — the act-now path",
  "dashboard-widget": "a dashboard widget's own inline control",
  "quick-log": "the command palette and the quick-log sheet",
  page: "the domain page's own form",
  "offline-replay": "a queued write replayed by /api/offline-replay",
  import:
    "not a user interaction; the row came from an importer (`source` holds which)",
};

/** Every value of the vocabulary, derived from the exhaustive record above. */
export const LOGGED_VIA_VALUES = Object.keys(
  LOGGED_VIA_MEANING
) as readonly LoggedVia[];

/**
 * The surfaces a WEB request can legitimately claim.
 *
 * A browser posts its surface as a form field, because the server cannot otherwise
 * tell the dashboard widget from the quick-log sheet from the page form — they are
 * three mountings of one Server Action. That field is attacker-controlled like any
 * other, so the parse below refuses anything outside this subset: a forged post
 * cannot dress a web tap up as a Telegram tap, an offline replay or an import, and
 * those three are exactly the values a later analysis would draw conclusions from.
 *
 * Same exhaustive-record discipline, and it is load-bearing here too: a new web
 * surface must be added deliberately rather than inherited.
 */
export type WebLoggedVia = Extract<
  LoggedVia,
  "dashboard-hero" | "dashboard-widget" | "quick-log" | "page"
>;

const WEB_ORIGINS: Record<WebLoggedVia, true> = {
  "dashboard-hero": true,
  "dashboard-widget": true,
  "quick-log": true,
  page: true,
};

/** The form field a client posts its surface in. */
export const LOGGED_VIA_FIELD = "logged_via";

/** Whether an arbitrary value is one of the vocabulary's members. */
export function isLoggedVia(value: unknown): value is LoggedVia {
  return typeof value === "string" && value in LOGGED_VIA_MEANING;
}

/**
 * Read a surface off an UNTYPED boundary (a FormData field, a JSON payload).
 *
 * An unknown string is REJECTED — never stored — and the caller's own home surface
 * stands in. That fallback lives at the Server Action, which knows where it is
 * mounted; it deliberately does NOT live in any write core, because a core with a
 * default is a core a new call site can land in the wrong bucket without noticing,
 * which is the failure this whole column exists to avoid.
 */
export function parseWebOrigin(
  raw: unknown,
  fallback: WebLoggedVia
): WebLoggedVia {
  return typeof raw === "string" && raw in WEB_ORIGINS
    ? (raw as WebLoggedVia)
    : fallback;
}

/**
 * The stamp every IMPORTER writes.
 *
 * Not a surface — it says no person acted, and `source` on the same row names which
 * importer or integration did. Named rather than spelled inline at each importer so
 * the two columns stay legibly orthogonal at every write site.
 */
export const IMPORTED: LoggedVia = "import";

/**
 * The stamp the offline queue's replay writes.
 *
 * DELIBERATELY the replay, not the surface that queued the write. A queued intent
 * carries no honest record of which control produced it — the surfaces are three
 * mountings of one action and the capture predates the round trip — so inventing one
 * at replay time would put a guess in a column whose entire value is that it does not
 * guess. `offline-replay` is the true answer to "how did this row get here".
 */
export const OFFLINE_REPLAY: LoggedVia = "offline-replay";
