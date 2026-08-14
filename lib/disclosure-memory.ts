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
//     for exactly this class: `allos:page-visits:v1` (lib/recent-pages.ts), the theme,
//     trend annotation visibility. No health data crosses it and nothing here is ever
//     read by a finding, a notification, or the Upcoming bus.
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
export type DisclosureId = "dashboard-prn-more" | "settings-group";

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
  "dashboard-prn-more": {
    reason:
      "The as-needed log card's fuller controls. A reader who uses PRN logging uses it daily.",
    defaultOpen: false,
    instanced: false,
  },
  "settings-group": {
    reason:
      "Settings groups. Returned to repeatedly while configuring one area; instanced per group.",
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
