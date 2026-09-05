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
  | "usual-backfill"
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
  "usual-backfill":
    'the composed "your usual <window>" one-tap, aimed at a PAST day (#4118) — a person acted, but on a day they were reconstructing rather than living',
  import:
    "not a user interaction; the row came from an importer — an import row carries `source` where known (#3808)",
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

// THE STAMPED PAYLOAD (#5349) — the type half of #3087, and the thing that used to be
// missing. `parseWebOrigin` above asks "which of my mountings posted this?", and until
// now NOTHING IN THE TYPE SYSTEM CONNECTED THE TWO: an action that read the field
// compiled perfectly with no client ever setting it, took its fallback on every
// request, and recorded `page` for the dashboard, the quick-log sheet and the command
// palette alike. A 1,261-line import-graph walk reconstructed the connection from
// source on every run, and a mounting reached by a path the walker did not know — a
// server component passing the action down as a prop, a "use server" module calling a
// sibling action — passed it silently. Both of those were in the tree.
//
// So the payload carries the declaration instead. This is the `Tx` token (lib/db.ts,
// #2133) on the form side: a value only this module can mint, required by the actions
// that read a surface, so the wrong caller is UNWRITABLE rather than something each
// mounting's author remembers. Under `strictFunctionTypes` a parameter is
// contravariant, so `(fd: StampedFormData) => …` is not assignable to
// `<form action>`'s `(fd: FormData) => …` — a bare DOM-collected mounting fails `tsc`
// at the JSX, which is the whole guard.
//
// WHAT IT DOES NOT CLAIM, and the boundary is ACCEPTED rather than overlooked: it says
// the payload CARRIES a declared surface, never that the declared surface is the true
// one. Nothing — type, lint or scan — can see the second, and the walk this replaced
// could not either: its `DECLARES_RE` counted a bare `.set(LOGGED_VIA_FIELD, …)` with
// any value as a declaration. So this is the honest limit of the mechanism, not a
// regression against it. `parseWebOrigin` still refuses anything outside the four web
// values, because the field rides the post and is attacker-controlled like any other.
// The brand is a discipline on OUR mountings; the parse is the gate on THEIR request.
// Both stay.
declare const WEB_ORIGIN_STAMP: unique symbol;
export type StampedFormData = FormData & { readonly [WEB_ORIGIN_STAMP]: true };

/**
 * Mint one. The ONLY door — every stamping mount reaches it through
 * `useLoggedViaStamp()` (which binds the surface to the region context) or through
 * `useWritePipeline`, which builds the FormData and stamps it so its callers never
 * hold an unstamped one.
 *
 * It takes the surface EXPLICITLY rather than only from context because two mountings
 * legitimately name their own: the command palette IS `quick-log` wherever it opens,
 * and the activity editor carries the surface it was opened from across a portal.
 * Those were `.set(LOGGED_VIA_FIELD, …)` by hand before this existed, which is the
 * same act with nothing to check it.
 */
export function stampWebOrigin(
  formData: FormData,
  surface: WebLoggedVia
): StampedFormData {
  formData.set(LOGGED_VIA_FIELD, surface);
  return formData as StampedFormData;
}

/**
 * The stamp every IMPORTER writes.
 *
 * Not a surface — it says no person acted, and `source` on the same row names which
 * importer or integration did. Named rather than spelled inline at each importer so
 * the two columns stay legibly orthogonal at every write site.
 *
 * ONE SHIPPED WRITE PATH STAMPS `import` WITH NO `source` AT ALL, and the meaning
 * string above says "where known" because of it (#3566). `commitWorkouts`
 * (app/(app)/data/actions.ts) bulk-imports a training log and receives only the
 * extracted workouts — the document is not in its signature — so there is no id for
 * a `document:<n>` to name, and inventing one would be worse than the NULL.
 *
 * RULED 2026-09-01 (#3808, question 2): IT KEEPS THE NULL, and the vocabulary was
 * amended instead. Plumbing a real `source` through was considered and overruled —
 * the two consumer flips it would buy (Trends' source comparison grows a series;
 * `lib/activity-draft.ts` reads `source != null` as "not a draft") are not worth
 * attribution nobody has asked for. The notes at those two sites stay as the record
 * of why. On these rows `import` means "no person acted" and nothing more.
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
 * IT IS NOT that the surface is unknowable. It is in scope at the `enqueue` calls —
 * `LogPracticeButton` already holds its surface when it queues, and a form that
 * enqueues declares one on its online branch of the same function — so carrying it
 * would be recording something the client knows and currently discards, not inventing
 * anything. (The dashboard's own weigh-in widget was the second example here until
 * #3366 retired it; the argument is unchanged, only that citation was.) The column stores one fact per row; the issue chose this one, and a
 * two-axis "queued from X, replayed" is a wider change than #3087 asked for.
 */
export const OFFLINE_REPLAY: LoggedVia = "offline-replay";

/**
 * The stamp the DATED "your usual <window>" one-tap writes (#4118).
 *
 * THE ONE VALUE THAT NAMES A DAY RATHER THAN A SURFACE, and it is the whole reason the
 * dated write could be allowed at all. "Usual" is DERIVED from `getFoodRegularity`, so a
 * bundle written onto a day nobody remembers would feed its own evidence back into
 * itself — three backfilled mornings become the reason a fourth is offered. The write is
 * therefore stamped distinguishably and `getFoodRegularity` excludes exactly this value
 * from its evidence window. Everywhere a PERSON looks — adherence, the ledgers, the day
 * views — the row counts like any other, because it records something that happened.
 *
 * IT REPLACES THE SURFACE, WHICH IS A REAL LOSS and is recorded as one: a backfill from
 * Telegram and a backfill from the web are indistinguishable in this column. One row
 * stores one fact, the guard needs this one, and a second axis is a wider change than
 * #4118 asked for. A CONTEMPORANEOUS usual tap is unaffected — it stamps its own surface
 * exactly as before, and counts as evidence exactly as before.
 *
 * NOT in `WebLoggedVia`: a browser may never CLAIM it. The write cores decide it, from
 * the date they were handed against the profile's own today.
 */
export const USUAL_BACKFILL: LoggedVia = "usual-backfill";

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
 *
 * `substance_daily_totals` (#4435) is the second day-row and follows that same rule,
 * with one thing worth naming beside it: this row DOES re-stamp `recorded_at` on every
 * tap, because the day's latest use is a fact about the day. Provenance still does not
 * move — a nicotine day opened from the page and topped up from the quick-log sheet
 * reads `page`.
 */
export const LEDGERS_WITH_LOGGED_VIA = [
  "intake_item_logs",
  "food_log_events",
  "practice_logs",
  "activities",
  "body_metrics",
  "symptom_logs",
  "medical_records",
  "substance_daily_totals",
] as const;

export type LedgerWithLoggedVia = (typeof LEDGERS_WITH_LOGGED_VIA)[number];
