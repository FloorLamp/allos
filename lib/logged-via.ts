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
    "not a user interaction; the row came from an importer (`source` names which, where the write path has one)",
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

/**
 * Whether an arbitrary value is one of the vocabulary's members.
 *
 * `Object.hasOwn`, never `in`: `in` walks the prototype chain, so `"toString"` and
 * `"constructor"` would both read as members of the closed set and a posted
 * `logged_via=constructor` would sail through. Caught by this module's own test.
 */
export function isLoggedVia(value: unknown): value is LoggedVia {
  return typeof value === "string" && Object.hasOwn(LOGGED_VIA_MEANING, value);
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
  // `Object.hasOwn` for the same reason isLoggedVia uses it: `in` would accept every
  // Object.prototype key as a web surface.
  return typeof raw === "string" && Object.hasOwn(WEB_ORIGINS, raw)
    ? (raw as WebLoggedVia)
    : fallback;
}

/**
 * The stamp every IMPORTER writes.
 *
 * Not a surface — it says no person acted, and `source` on the same row names which
 * importer or integration did. Named rather than spelled inline at each importer so
 * the two columns stay legibly orthogonal at every write site.
 *
 * ONE SHIPPED WRITE PATH STAMPS `import` WITH NO `source` AT ALL, and the meaning
 * string above is hedged because of it (#3566). `commitWorkouts`
 * (app/(app)/data/actions.ts) bulk-imports a training log and receives only the
 * extracted workouts — the document is not in its signature — so there is no id for
 * a `document:<n>` to name, and inventing one would be worse than the NULL. Giving
 * it a real `source` is a signature change plus two product consequences (Trends'
 * source comparison grows a series; `lib/activity-draft.ts` reads `source != null`
 * as "not a draft"), so it is a decision, not a cleanup. Until it is made, `import`
 * means "no person acted" and nothing more on those rows.
 */
export const IMPORTED: LoggedVia = "import";

/**
 * The stamp the offline queue's replay writes.
 *
 * DELIBERATELY the replay, not the surface that queued the write. #3087's acceptance
 * criteria require it in those words, and name the reason: what a later analysis needs
 * to know about these rows is that they arrived through the queue, because a replayed
 * write's timing tells you nothing about when the person acted.
 *
 * IT IS NOT that the surface is unknowable. It is in scope at both `enqueue` calls —
 * `WeightQuickAdd` sets `dashboard-widget` on the online branch of the same function,
 * and `LogPracticeButton` already holds its surface when it queues — so carrying it
 * would be recording something the client knows and currently discards, not inventing
 * anything. The column stores one fact per row; the issue chose this one, and a
 * two-axis "queued from X, replayed" is a wider change than #3087 asked for.
 */
export const OFFLINE_REPLAY: LoggedVia = "offline-replay";

/**
 * The ledgers that carry `logged_via` — #3087's first tranche, shipped by
 * `lib/migrations/versions/20260822-logged-via-provenance.ts`.
 *
 * The migration keeps its OWN copy of this list on purpose: a migration must describe
 * the schema IT shipped, and it must not start meaning something different when a
 * later tranche extends this one.
 *
 * TWO GUARDS HOLD THE COPIES TOGETHER, AND BOTH ASK IN BOTH DIRECTIONS. That matters
 * more than it sounds: a forward-only check (`for (const table of this list)`) is
 * satisfied by DELETING a name, so a shipped ledger could be quietly demoted into the
 * census's exclusion registry with every test still green — which is exactly what an
 * adversarial mutant did.
 *
 *   • `lib/__db_tests__/logged-via-provenance.test.ts` reads the LIVE SCHEMA — every
 *     table in `sqlite_master`, not just the ones named here — and asserts that the
 *     set carrying a `logged_via` column is EXACTLY this list.
 *   • `lib/__tests__/logged-via-census.test.ts` reads the MIGRATION'S OWN TEXT and
 *     asserts its tranche is exactly this list, in the pure tier where no database
 *     exists.
 */
/**
 * WHAT A `symptom_logs` STAMP ACTUALLY RECORDS, said here because the vocabulary above
 * does not fit that ledger without a sentence (#3566).
 *
 * `symptom_logs` is `UNIQUE(profile_id, date, symptom)` — a DAY-ROW, upserted, whose
 * severity is raised by later reports of the same symptom on the same day. `logged_via`
 * is correctly absent from both `DO UPDATE SET` clauses, because this column records
 * CREATION and never mutation. So the stamp names the surface that OPENED the day-row,
 * not the surface behind its current severity: a symptom first logged on the page and
 * then worsened from a Telegram tap still reads `page`.
 *
 * That is the creation-not-mutation rule working exactly as #3087 specifies. It is
 * written down because "which surface a person used" reads, at a glance, like a claim
 * about the row's present value, and #3077's ranker is what will read it.
 */
export const LEDGERS_WITH_LOGGED_VIA = [
  "intake_item_logs",
  "food_log_events",
  "practice_logs",
  "activities",
  "body_metrics",
  "symptom_logs",
  "medical_records",
] as const;

export type LedgerWithLoggedVia = (typeof LEDGERS_WITH_LOGGED_VIA)[number];
