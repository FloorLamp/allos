// WHICH SURFACES THIS PROFILE ACTS ON (issue #4249) — the read model's pure half.
//
// `logged_via` (lib/logged-via.ts) has been fully built on the WRITE side since
// #3087: Telegram stamps its origins, web regions self-declare through the
// `LoggedViaSurface` context, and every write core in `LEDGERS_WITH_LOGGED_VIA`
// threads it. Until this module it had no analytical reader at all — the column
// recorded a fact nothing asked. This is where the asking is declared, and
// `lib/queries/surface-usage.ts` is where it is counted.
//
// ── THE QUESTION, STATED ONCE ────────────────────────────────────────────────
//
// "Which surfaces does this profile act on, per ledger, over a declared window."
// The LEDGER is the domain grain for provenance — it is the grain the column is
// written at, and `LEDGERS_WITH_LOGGED_VIA` is already exhaustive over it, so a
// later tranche member cannot join the schema without joining this read model.
//
// ── THE GUARDRAIL, WHICH IS OLDER THAN THIS MODULE ───────────────────────────
//
// The #3077 arc's standing rule, restated by #4249 and binding on every consumer
// here: **usage evidence may pick a default or an order, never remove or hide.**
// Knowing somebody logs food in the chat and symptoms on the web is grounds for
// opening a sheet on Care. It is never grounds for dropping Consume from the
// sheet, for hiding a domain, or for sending anybody a message about it. Every
// consumer of this model must leave every domain exactly as reachable as it was.

import type { LoggedVia } from "./logged-via";

/**
 * The trailing window this model reads, in days.
 *
 * A QUARTER, and the size is the decision rather than a default. A week answers
 * "what did they do lately", which is the wrong question: a surface preference is
 * a habit, and a habit that took a fortnight off is still the habit. A year would
 * keep counting a surface somebody abandoned in the spring. Ninety days is long
 * enough that one busy week cannot carry it and short enough that a real switch —
 * a person who stopped using the chat in June — shows through by autumn.
 *
 * `LOG_HABIT_WINDOW_DAYS` (lib/log-sheet.ts) is a SEPARATE declaration that also
 * reads 90, and deliberately stays separate: it is the log sheet's stabiliser,
 * argued from the churn cost of a moving default, and its consumer passes it in
 * explicitly. The two agreeing today is not a fact either module may assume.
 */
export const SURFACE_USAGE_WINDOW_DAYS = 90;

/**
 * What a stamped row says about WHERE a person was, as opposed to which control
 * they touched.
 *
 *   web      — a browser. The four `WebLoggedVia` surfaces, plus the replay of a
 *              write the browser queued offline.
 *   telegram — the chat.
 *   none     — no channel is claimed by the row: either nobody acted, or the value
 *              records something other than a surface.
 */
export type SurfaceChannel = "web" | "telegram" | "none";

/**
 * Every value's channel. `Record<LoggedVia, SurfaceChannel>` for the same reason
 * `LOGGED_VIA_MEANING` is one — it is exhaustive in BOTH directions, so a tenth
 * vocabulary member is a compile error here rather than a value that silently
 * counts as no channel at all and quietly shrinks somebody's evidence.
 *
 * THE TWO ARGUED `none`s ARE THE INTERESTING ROWS:
 *
 *   • `import` says no person acted. An importer's rows are not evidence about
 *     anybody's surfaces — this is the same reasoning the habit measure used to
 *     spell as a `source` filter, now read off the column that actually means it.
 *   • `usual-backfill` REPLACES the surface rather than naming one (#4118, and the
 *     loss is recorded there too): a backfill from the chat and a backfill from
 *     the web are indistinguishable in this column. Counting it as web would
 *     credit the web with taps that may have happened in Telegram, which is
 *     exactly the defect #4249 exists to remove.
 *
 * AND THE ONE THAT IS NOT `none`. `offline-replay` names the QUEUE rather than the
 * region that filled it, and the surface really is lost — but the channel is not.
 * The offline queue exists only in the browser (`lib/offline/`), so a replayed
 * write is a web act whose finer provenance was discarded. Reading it as `none`
 * would delete evidence we hold, and the guardrail above forbids removing.
 */
export const SURFACE_CHANNEL = {
  "telegram-nudge": "telegram",
  "telegram-command": "telegram",
  "telegram-text": "telegram",
  "dashboard-hero": "web",
  "dashboard-widget": "web",
  "quick-log": "web",
  page: "web",
  "offline-replay": "web",
  "usual-backfill": "none",
  import: "none",
} as const satisfies Record<LoggedVia, SurfaceChannel>;

/**
 * The channel a stored value names, for an arbitrary string read back out of the
 * database.
 *
 * A ROW WHOSE `logged_via` IS NULL OR UNRECOGNISED IS `none`, AND THAT IS THE
 * HONEST ANSWER RATHER THAN A GAP. The column arrived nullable with no backfill
 * (#3087), so every row written before 2026-08-22 carries NULL: the app does not
 * know which surface produced it. "Unknown" is not evidence that a person acts on
 * the web, and treating it as web would re-create the very claim this model
 * exists to stop making. The cost is stated rather than hidden — a profile whose
 * logging is all older than the tranche reads as no surface usage at all, and
 * every consumer here must have a no-evidence answer that hides nothing.
 */
export function surfaceChannel(
  value: string | null | undefined
): SurfaceChannel {
  return value != null && Object.hasOwn(SURFACE_CHANNEL, value)
    ? SURFACE_CHANNEL[value as LoggedVia]
    : "none";
}

/** The vocabulary members on a given channel, derived from the record above. */
function surfacesOn(channel: SurfaceChannel): readonly LoggedVia[] {
  return (Object.keys(SURFACE_CHANNEL) as LoggedVia[]).filter(
    (via) => SURFACE_CHANNEL[via] === channel
  );
}

/** The surfaces a WEB act carries. Derived — never a second hand-kept list. */
export const WEB_ACT_SURFACES = surfacesOn("web");

/** The surfaces a CHAT act carries. Derived, for the same reason. */
export const TELEGRAM_ACT_SURFACES = surfacesOn("telegram");
