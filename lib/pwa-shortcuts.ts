// PWA manifest shortcuts + the `?quick=` deep-link they land on (issue #1424,
// section A).
//
// Long-pressing the installed home-screen icon opens an OS menu of app
// shortcuts. Each entry here is a plain in-scope URL carrying `?quick=<id>`,
// which `components/QuickShortcutHandler.tsx` interprets on arrival to open the
// SAME surface the quick-log sheet and the command palette already open. No new
// entry paths: the handler dispatches the existing `QuickLogTarget` union
// exactly as `QuickLogSheet.run` does (#1476), or calls `openGlobalSearch()`.
//
// **The labels are not restated here.** A shortcut that logs a dose takes its
// name and description from the SAME `QUICK_LOG_ITEMS` row the sheet renders, so
// "Log dose" on the home screen and "Log dose" in the sheet cannot drift into
// two different words for one action (the one-question-one-computation rule
// applied to copy). Only Search — which is not a quick-log item — carries its own
// strings.
//
// **Resolution is over the quick-log registry, not over this list.** `?quick=`
// admits any `QUICK_LOG_ITEMS` id (plus `search`), so a hand-written or
// notification deep link to any sheet row works; the manifest merely EXPOSES the
// three the OS menu has room for. One registry, one resolver, one dispatch.
//
// Session gating is the app's usual one: these are ordinary app URLs, so an
// anonymous tap hits the middleware and lands on `/login?next=/%3Fquick%3D…`
// (the redirect preserves the query), then replays the shortcut after sign-in.

import type { AppRoute } from "./hrefs";
import {
  LOG_ACTIVITY_ID,
  QUICK_LOG_ITEMS,
  type QuickLogItem,
} from "./quick-log";

// The query param a shortcut (or any deep link) uses to ask the shell to open a
// logger. Deliberately NOT `FOCUS_PARAM` ("new"): that convention means
// "navigate to a page, then scroll/focus its inline form", and it is already
// spoken on routes a shortcut could target (`/trends?new=weight#body`).
// Overloading it would make one param mean two things on one URL.
export const QUICK_PARAM = "quick";

// The one non-quick-log shortcut: open the command palette.
export const SEARCH_SHORTCUT_ID = "search";

// What a `?quick=` value resolves to. Mirrors the sheet's dispatch: a quick-log
// row (whose `target` the handler switches on, exhaustively) or the palette.
export type ShortcutAction =
  { kind: "quick-log"; item: QuickLogItem } | { kind: "search" };

export interface PwaShortcut {
  // The `?quick=` value AND the manifest entry's identity. For a quick-log
  // shortcut this IS the `QuickLogItem.id` — no second id namespace to keep in
  // sync.
  id: string;
  name: string;
  description: string;
  // A real, compile-checked app route (#285). Written as a literal because
  // typedRoutes can only validate one; `pwa-shortcuts.test.ts` pins that each
  // literal equals `/?${QUICK_PARAM}=${id}`, so the two can't drift.
  url: AppRoute;
}

function quickLogShortcut(id: string, url: AppRoute): PwaShortcut {
  const item = QUICK_LOG_ITEMS.find((i) => i.id === id);
  if (!item) {
    throw new Error(`pwa-shortcuts: no quick-log item "${id}"`);
  }
  return { id, name: item.label, description: item.hint, url };
}

// The OS menu, in order. Deliberately THREE — Android surfaces at most four and
// iOS fewer, and a long-press menu is only useful while it stays scannable.
// "Log activity" and "Log dose" are the two highest-frequency writes; Search is
// the read side (the palette reaches every record).
export const PWA_SHORTCUTS: readonly PwaShortcut[] = [
  quickLogShortcut(LOG_ACTIVITY_ID, "/?quick=log-activity"),
  quickLogShortcut("log-dose", "/?quick=log-dose"),
  {
    id: SEARCH_SHORTCUT_ID,
    name: "Search",
    description: "Find any record, page, or action",
    url: "/?quick=search",
  },
];

// Resolve a `?quick=` value to the surface to open, or null for "do nothing".
//
// The lookup is STRICT on purpose. `quickLogItem(id)` falls back to "log
// activity" for an unknown id — correct for the sheet (a bad id there is a bug),
// wrong here: a stale bookmark, a truncated share, or `?quick=lol` would pop an
// activity editor the user never asked for. An unrecognized value is a no-op.
//
// `restricted` is the age gate (`lib/age-gate.ts`): a training-restricted
// profile has no training surface at all, so a training-only row resolves to
// null rather than opening an editor that profile can't use — the same gate the
// sheet's `quickLogMenu` applies. `cycleRelevant` is the #1042 relevance bit and
// applies the same way to the period row (#1892) — both default to the permissive
// value so a caller that hasn't threaded a bit never breaks a working shortcut.
export function shortcutAction(
  value: string | null | undefined,
  restricted = false,
  cycleRelevant = true
): ShortcutAction | null {
  if (!value) return null;
  if (value === SEARCH_SHORTCUT_ID) return { kind: "search" };
  const item = QUICK_LOG_ITEMS.find((i) => i.id === value);
  if (!item) return null;
  if (item.training && restricted) return null;
  if (item.cycle && !cycleRelevant) return null;
  return { kind: "quick-log", item };
}
