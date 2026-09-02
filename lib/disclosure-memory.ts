// DISCLOSURE MEMORY (#2652 behavior 3 — "a disclosure remembers its open state, per
// device"). PURE — no DB, no `window`, no JSX. The I/O lives in
// components/RememberedDetails.tsx; everything that DECIDES anything is here and unit
// tested.
//
// WHY THIS IS NOT A SETTING, AND WHERE IT WOULD GO IF IT WERE.
// The repo has three places a preference can live, and they answer three different
// questions. Getting this one wrong leaks one person's UI state onto another's screen,
// so the reasoning is written down rather than implied:
//
//   • `profile_settings` — keyed by PROFILE, the DATA SUBJECT. Wrong twice over. A fold
//     being open is not a fact about a person's health, and a caregiver switching
//     between their own board and a child's on one screen would carry the child's fold
//     state onto the parent's. AGENTS.md's first universal rule is exactly this
//     distinction; a profile setting here would conflate an ergonomic gesture with a
//     property of the subject.
//   • `login_settings` — keyed by LOGIN, the AUTHENTICATION IDENTITY (lib/settings/kv.ts,
//     lib/settings/display.ts). Correct owner, wrong REACH: it is server-stored, so it
//     follows that login to every device it signs in on. "Per device" is precisely the
//     thing this tier cannot express — collapsing a card on the phone would collapse it
//     on the desktop, where the height it saves is height nobody needed saved. It is
//     also a server write on every disclosure tap, which is a chatty path for a gesture
//     that must feel free.
//   • `localStorage` — keyed by DEVICE (browser profile). The tier the repo already uses
//     for exactly this class: the theme, trend annotation visibility. (It also held
//     `allos:page-visits:v1` until #4102 retired the frequent-pages row and deleted the
//     key outright.) No health data crosses it and nothing here is ever read by a
//     finding, a notification, or the Upcoming bus.
//
// So: localStorage, and deliberately so. The GRADUATION PATH stays open in the other
// direction — #2652 §4's rule is that a preference which earns cross-device permanence
// becomes a real `login_settings` display preference on purpose, never by this store
// quietly growing a sync. Memory is not a back door into the settings tiers.
//
// WHAT MAY REMEMBER, AND WHAT MAY NOT (owner ruling, 2026-08-13 — ratified scoped).
// This is an ALLOWLIST, not a behavior every `<details>` inherits. The scope is ROUTINE
// surfaces a person returns to daily, where re-opening the same fold every morning is
// friction with no information in it. Two kinds of fold are held OUT by construction:
//   • FINDINGS folds and SUPPRESSION views. A fold that was open once must never be
//     pre-opened into a wall of findings the reader did not ask for on this visit; the
//     collapsed state is what makes those surfaces readable at all.
//   • NARROWING controls of any kind. Remembering a filter is the classic trap — data
//     reads as "missing" because last week's narrowing survived. Nothing that changes
//     WHICH data is shown belongs in this store; see #2652 §4.
//
// REDUCED MOTION (#2654). Restoring an open fold is a STATE, not a transition: the
// disclosure renders already-open, with no height animation to miss. Both states are
// legible standing still, which is what makes this safe to restore before first paint's
// successor render rather than "animate open on arrival".

// The store's key. Versioned so a shape change can be dropped rather than migrated —
// a forgotten fold costs the reader one tap, so migration is never worth writing.
export const DISCLOSURE_MEMORY_KEY = "allos:disclosure:v1";

/**
 * The disclosures that may remember. Adding one is a deliberate edit with a reason and
 * a test to update, never an inheritance — see the scope rules above.
 */
export type DisclosureId =
  | "settings-group"
  | "dashboard-all"
  | "notify-channel";

export interface DisclosureDeclaration {
  /** Why this fold is ROUTINE — the daily return that makes re-opening it friction. */
  readonly reason: string;
  /**
   * What the disclosure shows with nothing remembered. Memory only ever fills this in;
   * it never makes state invisible, because a `<details>` always renders its own marker.
   */
  readonly defaultOpen: boolean;
  /**
   * Whether this id is INSTANCED — one remembered state per instance (a settings group
   * per group name), rather than one for the whole app. Instanced ids are stored as
   * `id/instance`.
   */
  readonly instanced: boolean;
}

export const DISCLOSURES: Record<DisclosureId, DisclosureDeclaration> = {
  "settings-group": {
    reason:
      "Settings groups. Returned to repeatedly while configuring one area; instanced per group.",
    defaultOpen: false,
    instanced: true,
  },
  "dashboard-all": {
    reason:
      "The routine dashboard remainder returns on every visit and may stay open on this device.",
    defaultOpen: false,
    instanced: false,
  },
  // #2565 A. A channel row is one-time plumbing a person opens while setting a channel
  // up and returns to across several visits to finish; instanced per channel so opening
  // Telegram does not open Email. NOT a narrowing control — the strip shows all four
  // channels either way, and the fold only holds that channel's own configuration.
  // An ERRORING row passes an explicit `defaultOpen`, which by RememberedDetails'
  // contract wins and remembers nothing, so a forced-open failure never becomes a
  // remembered-open row after it heals.
  "notify-channel": {
    reason:
      "Channel setup on Settings → Notifications, returned to while getting a channel working; instanced per channel.",
    defaultOpen: false,
    instanced: true,
  },
};

export const DISCLOSURE_IDS = Object.keys(DISCLOSURES) as DisclosureId[];

/**
 * Folds that are deliberately STATELESS, with the reason. Kept as data so the rule is
 * testable and a future edit that tries to remember one of these fails a test instead of
 * shipping. These are not ids — they are the classes an id may never name.
 */
export const STATELESS_FOLD_CLASSES: readonly {
  readonly name: string;
  readonly reason: string;
}[] = [
  {
    name: "findings",
    reason:
      "A remembered-open findings fold pre-opens a wall the reader did not ask for on this visit.",
  },
  {
    name: "suppression",
    reason:
      "Snoozed and dismissed views are an audit surface; their collapsed state is what keeps them readable.",
  },
  {
    name: "narrowing-filter",
    reason:
      "Remembering which data is shown makes data read as missing. Modes may persist; narrowing never does.",
  },
] as const;

// THE LATE-RESTORE HAZARD, and why it is no longer a reason to exclude anything.
//
// Per-device state is INVISIBLE TO THE SERVER by construction — that is what makes it
// per-device — so a remembered-open fold cannot be server-rendered open. The first
// version of this feature therefore restored it after hydration, and that was wrong in a
// way that took CI to show: between first paint and hydration the fold is closed on
// screen AND closed in the DOM, and then it opens. A tap issued in that window is aimed
// at a closed fold and lands on an open one, so it shuts it. On a settings page that
// costs a reader one confusing tap; above a log control it would move the control out
// from under a thumb.
//
// `DISCLOSURE_BOOT_SCRIPT` closes that window rather than routing around it: the fold's
// height is right in the FIRST PAINTED FRAME, so there is no interval in which the
// pixels and the store disagree. With that in place the hazard is not a property of
// certain folds; it is gone.
//
// What that leaves is a pure SCOPE question, not a safety one. `dashboard-prn-more` is
// still out of the registry, but now only because #2652 §3's "dashboard cards" is a
// broader claim than one fold and deserves to be chosen deliberately rather than
// inherited from whichever fold this change happened to touch first.

/** The stored shape: one entry per remembered fold, 1 = open, 0 = closed. */
export type DisclosureMemory = Record<string, 0 | 1>;

/**
 * The stored key for a disclosure. An instanced id carries its instance; a non-instanced
 * one ignores any instance passed, so a caller cannot accidentally fragment a single
 * fold's memory into per-page copies.
 */
export function disclosureKey(id: DisclosureId, instance?: string): string {
  if (!DISCLOSURES[id].instanced) return id;
  const slug = (instance ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return slug ? `${id}/${slug}` : id;
}

/**
 * Whether this disclosure should render open. Memory FILLS THE DEFAULT and nothing more:
 * an unremembered fold takes its declared default, and a caller with an explicit state
 * (a URL, a parent deciding) passes `override` and wins outright — the same precedence
 * #2652 §4 fixes for view modes.
 */
export function disclosureOpen(
  memory: DisclosureMemory,
  id: DisclosureId,
  options: { instance?: string; override?: boolean } = {}
): boolean {
  if (options.override !== undefined) return options.override;
  const stored = memory[disclosureKey(id, options.instance)];
  if (stored === undefined) return DISCLOSURES[id].defaultOpen;
  return stored === 1;
}

/**
 * Fold a toggle into the store. Returns a NEW object (never mutates). A state that
 * matches the declared default is DROPPED rather than written: the store stays the set of
 * deliberate departures, so changing a default later reaches everyone who never chose.
 */
export function rememberDisclosure(
  memory: DisclosureMemory,
  id: DisclosureId,
  open: boolean,
  instance?: string
): DisclosureMemory {
  const key = disclosureKey(id, instance);
  const next: DisclosureMemory = { ...memory };
  if (open === DISCLOSURES[id].defaultOpen) delete next[key];
  else next[key] = open ? 1 : 0;
  return next;
}

/**
 * Parse the stored JSON defensively — a hand-edited, half-written or stale-shaped value
 * must degrade to "nothing remembered", never throw inside a render. Unknown ids are
 * dropped on read, so a disclosure removed in a later change cannot leave a growing
 * residue behind.
 */
export function parseDisclosureMemory(raw: string | null): DisclosureMemory {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: DisclosureMemory = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    const id = key.split("/")[0] as DisclosureId;
    if (!(id in DISCLOSURES)) continue;
    if (value !== 0 && value !== 1) continue;
    out[key] = value;
  }
  return out;
}

export function serializeDisclosureMemory(memory: DisclosureMemory): string {
  return JSON.stringify(memory);
}

/**
 * The DOM attribute a remembering `<details>` carries its stored key in. The boot script
 * below matches on it, so a fold with an explicit caller state simply omits it and is
 * invisible to the restore.
 */
export const DISCLOSURE_KEY_ATTR = "data-disclosure-key";

/**
 * The PRE-PAINT restore, inlined by app/layout.tsx in `<head>` — the same shape
 * `THEME_BOOT_SCRIPT` uses, and for the same reason: a state that must be right in the
 * FIRST FRAME cannot wait for a bundle.
 *
 * WHY THIS EXISTS, precisely, because it was caught in CI rather than in review.
 * Restoring AFTER hydration is not merely a flash, it is a correctness bug. A `<details>`
 * the server rendered closed and memory then opens has a window — first paint to
 * hydration — in which the DOM and the pixels agree, and both are about to change. A tap
 * issued in that window is aimed at a closed fold and lands on an open one, so it CLOSES
 * it: the reader asked to open something and it shut. Two e2e specs are exactly that
 * reader — they read `open`, see false, click, and find the contents hidden.
 *
 * Two fixes that look reasonable and are NOT, worth recording so they are not retried:
 * "only restore when a stored entry exists" does nothing, because the entry exists; and
 * "never let a restore close what the user opened" does nothing, because this restore
 * only ever OPENS. The harm is not the restore's direction. It is that the restore is
 * LATE. So the fix is to stop being late.
 *
 * A MutationObserver rather than a `querySelectorAll` sweep, because the document is
 * STREAMED and the folds do not exist when this runs. Observer callbacks are delivered as
 * microtasks at the end of the task that parsed the node, and the browser paints between
 * tasks — so a fold's height is right in the first frame it is painted in.
 *
 * Runs ONCE per document, and deliberately has no `ThemeReassert`-style safety net: on a
 * client-side route change the folds are rendered by React, which reads the same store on
 * its first render and is correct without help. Only the server-rendered first document
 * needs this.
 */
export const DISCLOSURE_BOOT_SCRIPT = `
(function () {
  try {
    var raw = localStorage.getItem('${DISCLOSURE_MEMORY_KEY}');
    if (!raw) return;
    var mem = JSON.parse(raw);
    if (!mem || typeof mem !== 'object' || Array.isArray(mem)) return;
    var sel = 'details[${DISCLOSURE_KEY_ATTR}]';
    var apply = function (el) {
      var v = mem[el.getAttribute('${DISCLOSURE_KEY_ATTR}')];
      if (v === 1) el.open = true;
      else if (v === 0) el.open = false;
    };
    var scan = function (node) {
      if (!node || node.nodeType !== 1) return;
      if (node.matches && node.matches(sel)) apply(node);
      if (node.querySelectorAll) {
        var found = node.querySelectorAll(sel);
        for (var i = 0; i < found.length; i++) apply(found[i]);
      }
    };
    var obs = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', function () {
      scan(document.body);
      obs.disconnect();
    });
  } catch (e) {}
})();
`;
