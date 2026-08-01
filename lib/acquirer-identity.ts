// The PURE vocabulary of the MyChart acquirer surface (issues #1739, #1735) — portal
// slugs, patient labels, the upload-target contract, and the sync-report status set. No
// DB, no network, no request, so every decision an untrusted caller can reach is
// unit-testable on its own.
//
// This module is the answer to a question deliberately left unanswered when the upload
// endpoint shipped: an acquirer must not decide profile ids from local config, because a
// stale local mapping files one person's records under another. So the tool names an
// EXTERNAL IDENTITY and allos resolves it. The vocabulary of that identity is owned
// here.
//
// ── WHY ALLOS OWNS THE PORTAL IDENTITY, AND NEVER ITS ADDRESS ────────────────
//
// A portal is two things with different owners. Its IDENTITY (`ochsner`, "Ochsner
// MyChart") is allos-owned: the mapping table needs a foreign key allos controls, sync
// events and provenance need one stable portal key across every device running the tool,
// and setup can then precede the first run instead of allos learning strings reactively.
// Its ADDRESS (the actual URL) is tool-owned — bound in the tool's local config,
// trust-on-first-use, pinned on the user's machine.
//
// Allos therefore never stores, transmits, or accepts an address. That is not a policy
// applied at each call site; it is enforced HERE, at the one validation boundary, so the
// standing rule — *any future trigger payload may carry names and ids resolved against
// local config, never a URL* — holds BY CONSTRUCTION. The authoritative record contains
// nothing resolvable, so a hostile page or a compromised job queue cannot aim the tool at
// an attacker-controlled login form. `rejectsAddress()` below is that gate, and it is
// applied to the display NAME as well as the slug: a free-text field is exactly where a
// URL would otherwise slip in.

// ── Portal slug ──────────────────────────────────────────────────────────────

// Lowercase kebab-case, letters/digits/hyphens only. Deliberately narrow: it excludes
// every character a URL needs (`:`, `/`, `.`, `@`, whitespace), so a slug is structurally
// incapable of being an address even before rejectsAddress() looks at it.
const PORTAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PORTAL_SLUG_MAX = 40;
export const PORTAL_NAME_MAX = 80;
export const PATIENT_LABEL_MAX = 120;

export function isPortalSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= PORTAL_SLUG_MAX &&
    PORTAL_SLUG_RE.test(value)
  );
}

// An ACCOUNT slug — "which portal login", scoped to its portal. Same shape as a portal
// slug and for the same reason: it is quoted in a tool's local config and in sync events,
// so it must be stable, typeable, and structurally incapable of being an address.
export function isAccountSlug(value: string): boolean {
  return isPortalSlug(value);
}

// MINT a slug from a display name.
//
// Allos owns the slug, so the user names the thing and allos derives the key. That
// inversion matters: a slug is what a tool's local config quotes, so it must never change
// under the user's feet. Typing it by hand invites a household to "fix" it later and
// silently break every device's config; deriving it once, at creation, means a later
// RENAME changes only the display name and the key holds.
//
// Deliberately lossy and deterministic: lowercase, accents folded to their base letters,
// every run of non-alphanumerics collapsed to one hyphen, hyphens trimmed, truncated to
// the slug ceiling on a hyphen boundary. Two different names can therefore mint the same
// slug — that is the DB layer's problem to disambiguate (it appends a counter), not this
// function's, because a pure function cannot know what already exists.
//
// Returns "" when a name has no slug-able characters at all (e.g. "•••"); the caller
// refuses rather than inventing a key.
export function mintSlug(name: string): string {
  const folded = name
    .normalize("NFKD")
    // Strip combining marks so "Hôpital Général" mints "hopital-general" rather than
    // dropping the accented letters entirely.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const hyphenated = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (hyphenated.length <= PORTAL_SLUG_MAX) return hyphenated;
  // Truncate on a hyphen boundary so a cut never leaves a trailing separator or half a
  // word gluing itself to the counter the DB layer may append.
  const cut = hyphenated.slice(0, PORTAL_SLUG_MAX);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, "");
}

// Does this text look like a network address? Used to refuse a URL wherever a human can
// type one. Broad on purpose — a scheme, a `//` authority, a bare host with a dot and a
// plausible TLD, an IPv4 literal, or a userinfo `@` all count. False positives here cost
// a portal a nicer display name; a false NEGATIVE would put a resolvable address into the
// authoritative record, which is the one thing this design promises never to do.
export function rejectsAddress(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  if (/[a-z][a-z0-9+.-]*:\/\//.test(v)) return true; // scheme://
  if (v.startsWith("//")) return true; // protocol-relative
  if (/^[a-z][a-z0-9+.-]*:/.test(v) && !/^\d+$/.test(v.split(":")[1] ?? ""))
    return true; // scheme: (mailto:, javascript:)
  if (/@/.test(v)) return true; // userinfo / email
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(v)) return true; // IPv4 literal
  if (/[a-z0-9-]+\.[a-z]{2,}(?:[/:?#]|$)/.test(v)) return true; // host.tld
  if (v.includes("/")) return true; // any path separator
  return false;
}

// ── Patient label ────────────────────────────────────────────────────────────

// Normalize a patient label for use as a mapping KEY.
//
// A label is a KEY, NOT A SEARCH. The portal's proxy list defines these strings; the tool
// discovers and reports them verbatim; allos only binds them. So this deliberately does
// NOT case-fold, strip punctuation, or do any fuzzy matching: two labels that differ in
// any visible way are two different people until a human says otherwise, and quietly
// unifying them is precisely how one patient's records land under another's profile.
//
// What it DOES remove is transport noise that no portal meant to be significant: leading
// and trailing whitespace, and runs of internal whitespace collapsed to one space (a
// label rendered across a line break must not become a second, unmapped identity). Both
// the write and the lookup go through this, so a binding is always findable by the same
// string that created it.
export function normalizePatientLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isPatientLabel(value: string): boolean {
  const v = normalizePatientLabel(value);
  return v.length > 0 && v.length <= PATIENT_LABEL_MAX;
}

// ── The upload-target contract ───────────────────────────────────────────────

// How one upload request names its destination. EXACTLY ONE of the two forms must be
// present: the human CLI keeps naming a profile id, and the acquirer names an external
// identity allos resolves. Both together is a contradiction, not a precedence question —
// answering it by preferring one would silently ignore the other, and "silently ignored
// the destination I named" is the failure mode this whole surface exists to prevent.
export type UploadTarget =
  | { kind: "profile"; profileId: number }
  | {
      kind: "identity";
      portalSlug: string;
      // WHICH LOGIN, or null when the caller omitted it. Optional on the wire on purpose:
      // a single-login household never meets the concept, and its tool config has nothing
      // to say here. Null does NOT mean "any account" — the DB layer resolves it against
      // the portal's account set and REFUSES if that set makes the answer ambiguous. This
      // module cannot make that call: it is pure, and ambiguity is a fact about stored
      // rows.
      accountSlug: string | null;
      patientLabel: string;
    };

export type UploadTargetResult =
  { ok: true; target: UploadTarget } | { ok: false; error: string };

// Accept only a plain positive decimal, the same rule the token wire format and the
// original `profile` parameter use: one destination, one spelling.
function parseProfileId(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw : "";
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

export function parseUploadTarget(input: {
  profile?: unknown;
  portal?: unknown;
  account?: unknown;
  patient?: unknown;
}): UploadTargetResult {
  const hasProfile = text(input.profile).trim() !== "";
  const portal = text(input.portal).trim();
  const account = text(input.account).trim();
  const patient = text(input.patient);
  const hasIdentity = portal !== "" || patient.trim() !== "" || account !== "";

  if (hasProfile && hasIdentity) {
    return {
      ok: false,
      error:
        "name either a `profile` or a (`portal`, `patient`) identity, not both",
    };
  }
  if (!hasProfile && !hasIdentity) {
    return {
      ok: false,
      error:
        "a destination is required: either a `profile` id or a (`portal`, `patient`) identity",
    };
  }

  if (hasProfile) {
    const profileId = parseProfileId(text(input.profile).trim());
    if (profileId === null) {
      return { ok: false, error: "`profile` must be a positive integer id" };
    }
    return { ok: true, target: { kind: "profile", profileId } };
  }

  // Identity form: `portal` and `patient` are BOTH required. A portal with no patient
  // cannot identify a person on a proxy-access login, and a patient with no portal is not
  // a key at all. `account` is OPTIONAL — omitting it is how a single-login household
  // never meets the concept — but a MALFORMED one is refused rather than ignored, because
  // silently dropping a named login is how a run lands under the wrong one.
  if (!isPortalSlug(portal)) {
    return { ok: false, error: "`portal` must be a known portal id" };
  }
  if (account !== "" && !isAccountSlug(account)) {
    return { ok: false, error: "`account` must be a known account id" };
  }
  if (!isPatientLabel(patient)) {
    return { ok: false, error: "`patient` must be a non-empty patient label" };
  }
  return {
    ok: true,
    target: {
      kind: "identity",
      portalSlug: portal,
      accountSlug: account === "" ? null : account,
      patientLabel: normalizePatientLabel(patient),
    },
  };
}

// ── Discovered identity lists ────────────────────────────────────────────────

// How many discovered labels one run report may contribute. A portal's proxy list is a
// household, not a directory: a dozen is generous and a hundred is a bug or an attack.
// Bounding here — at the PARSE, before anything is stored — keeps a single authenticated
// report from filling the pending list in one shot.
export const DISCOVERED_LABELS_MAX = 25;

// Parse the `identities` array an acquirer reports at the end of a run: the proxy-patient
// labels it actually saw on that login, VERBATIM.
//
// This is the routine path by which allos learns identities — the refusal path is the
// safety net for surprises, not the setup path. So it is the one place an untrusted tool
// writes strings that a human will later read and bind, and it is deliberately narrow:
// non-strings are dropped, labels are whitespace-normalized (never case-folded — a label
// is a key), anything that fails isPatientLabel is dropped, exact duplicates collapse,
// and the result is capped. Dropping rather than erroring is right for a REPORT: a run
// that genuinely happened must still be recorded even if one label was junk.
export function parseDiscoveredLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const label = normalizePatientLabel(entry);
    if (!isPatientLabel(label)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= DISCOVERED_LABELS_MAX) break;
  }
  return out;
}

// ── Sync report ──────────────────────────────────────────────────────────────

// How an acquirer run ended. `nothing-new` exists because it is the COMMON case and the
// one that is otherwise invisible: a run that checked the portal and found nothing pushes
// zero documents, so without an explicit report the server sees no trace at all and the
// card cannot tell "checked, unchanged" from "failed" — a quiet day would read as broken.
export const SYNC_REPORT_STATUSES = [
  "downloaded",
  "nothing-new",
  "failed",
] as const;

export type SyncReportStatus = (typeof SYNC_REPORT_STATUSES)[number];

export function isSyncReportStatus(value: string): value is SyncReportStatus {
  return (SYNC_REPORT_STATUSES as readonly string[]).includes(value);
}

// ── The sync-report target contract ──────────────────────────────────────────

// A run report names one MORE destination than an upload does.
//
// An upload always has a patient: it is carrying that person's document, so "which
// patient" is not optional information. A run report does not always have one. The
// likely failure mode of an attended acquirer is PRE-PATIENT — the portal's login page
// changed, the Document Center moved — and that is a fact about the LOGIN, true of every
// patient on it and of none in particular. Before this, saying "the portal is down"
// required inventing a patient label, which is a lie stored in the one table whose whole
// job is to keep patient labels honest.
//
// So a `failed` report may name a portal alone. NOTHING ELSE MAY: `downloaded` and
// `nothing-new` are claims ABOUT A PATIENT'S RECORDS ("I checked Jane and found nothing")
// and are meaningless without one, so they keep requiring a full target and keep the
// exact same refusal text they always had.
//
// `account` stays optional in exactly the sense it is optional everywhere else: the DB
// layer's omitted-account rule resolves it when the portal has one login and REFUSES when
// it has more. A portal-level failure does not get a softer version of that rule — a
// household with two logins must still say which one broke, because "one of your two
// logins is failing" is not an actionable sentence.
export type SyncReportTarget =
  | UploadTarget
  // A `failed` run that never reached a patient. Resolved to a login by the DB layer's
  // resolveAccount, exactly like the identity form's account component.
  | { kind: "portal"; portalSlug: string; accountSlug: string | null };

export type SyncReportTargetResult =
  { ok: true; target: SyncReportTarget } | { ok: false; error: string };

export function parseSyncReportTarget(
  status: SyncReportStatus,
  input: {
    profile?: unknown;
    portal?: unknown;
    account?: unknown;
    patient?: unknown;
  }
): SyncReportTargetResult {
  const portal = text(input.portal).trim();
  const account = text(input.account).trim();
  const portalOnly =
    status === "failed" &&
    text(input.profile).trim() === "" &&
    portal !== "" &&
    normalizePatientLabel(text(input.patient)) === "";

  if (!portalOnly) return parseUploadTarget(input);

  // Same validation the identity form applies to the same two fields — a portal-only
  // failure is a narrower target, not a laxer one.
  if (!isPortalSlug(portal)) {
    return { ok: false, error: "`portal` must be a known portal id" };
  }
  if (account !== "" && !isAccountSlug(account)) {
    return { ok: false, error: "`account` must be a known account id" };
  }
  return {
    ok: true,
    target: {
      kind: "portal",
      portalSlug: portal,
      accountSlug: account === "" ? null : account,
    },
  };
}

export interface SyncReportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  // Documents the run OFFERED and allos REFUSED because the user had deleted those bytes
  // (#1777). It rides the accounting category that already exists for exactly this fact —
  // `integration_sync_events.suppressed`, added by migration 023 for the #507/#508
  // re-import tombstones — rather than inventing a second word for "the tombstone blocked
  // a re-insert". `formatSplitLabel` already renders it, so a portal run reading
  // "2 new · 1 suppressed" needs no new UI.
  suppressed: number;
}

// Clamp a reported count to a sane non-negative integer. These numbers come from an
// external tool, so they are untrusted input, not a trusted accounting source.
function count(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(text(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1_000_000, Math.round(n)));
}

export function parseSyncReportCounts(input: {
  inserted?: unknown;
  updated?: unknown;
  unchanged?: unknown;
  failed?: unknown;
  suppressed?: unknown;
}): SyncReportCounts {
  return {
    inserted: count(input.inserted),
    updated: count(input.updated),
    unchanged: count(input.unchanged),
    failed: count(input.failed),
    // Absent from an older tool's report → 0, exactly like every other count. A client
    // that never meets a blocked document never has to know the field exists.
    suppressed: count(input.suppressed),
  };
}

// The sync-event shape a report becomes. Pure so "what does a nothing-new run look like
// in the accounting" is pinned by a test rather than by reading the route.
//
// The `ok` decision is the load-bearing one: `nothing-new` is a CALM SUCCESS — the run
// worked, it just had nothing to do — so it records ok:true and keeps the connection
// looking alive (the same stance Strava's quiet poll takes). Only `failed` is ok:false,
// which is what drives the Data → Review failure badge. Collapsing nothing-new into a
// failure would make every quiet day look broken; collapsing failed into a success would
// hide a portal that stopped working.
export interface SyncReportEvent {
  ok: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  suppressed: number;
  received: number;
  error: string | null;
}

export function syncReportEvent(
  status: SyncReportStatus,
  counts: SyncReportCounts,
  message: string | null
): SyncReportEvent {
  // A suppressed document WAS received — the run fetched it and offered it, and allos
  // refused. Leaving it out of the total would make the received/written split silently
  // stop adding up, which is the same silent cap `suppressed` exists to prevent.
  const received =
    counts.inserted +
    counts.updated +
    counts.unchanged +
    counts.failed +
    counts.suppressed;
  return {
    ok: status !== "failed",
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
    // Blocked by a content-hash tombstone (#1777): the user deleted these bytes, so the
    // re-offer was refused rather than stored. NOT a failure — the run did exactly the
    // right thing — so it never touches `ok`.
    suppressed: counts.suppressed,
    // A document the tool could not push is `skipped` in the shared vocabulary: it was
    // handed to the run but deliberately not persisted.
    skipped: counts.failed,
    received,
    // Only a failure carries an error line, and only the tool's own message — never
    // invented here, and truncated by the DB writer.
    error: status === "failed" ? (message ?? "sync failed") : null,
  };
}

// ── The tool-config payload (issue #1759) ────────────────────────────────────
//
// The portal and account slugs are ALLOS-MINTED vocabulary, and until this the tool
// operator hand-typed them into local config. A typo'd slug does not fail loudly — it
// produces a non-oracular `unmapped-identity` refusal deliberately indistinguishable
// from every other cause, which is correct security posture and miserable debugging. So
// the tool INGESTS the vocabulary instead of transcribing it.
//
// WHAT THIS SHAPE MAY CARRY, exhaustively: slug, name, software, and the accounts'
// slug/name/implicit. That list is the disclosure boundary, and it is enforced HERE, in
// one pure builder, rather than at the route — a field added to `Portal` or
// `PortalAccount` cannot leak by being spread into a response.
//
//   NO ADDRESS, ANYWHERE. "allos never stores, transmits, or accepts an address" holds
//   untouched: there is nothing in this payload that could aim a tool anywhere. The tool
//   still binds `slug → URL` locally, TOFU-pinned; this only guarantees the slug half of
//   that binding is spelled the way allos spells it. (allos has no address to leak — no
//   column exists — so this is a shape guarantee, not a redaction.)
//
//   NO PATIENT LABELS. Mapped, pending and ignored bindings are all absent. The tool
//   discovers patients from the portal itself; which patients a household mapped or
//   DECLINED is household information the non-oracular refusal already refuses to reveal
//   to whoever holds the token.
//
// `implicit` is included so a tool can derive the omitted-account rule for itself —
// exactly one account (the implicit one) means it may omit `account` on the wire; more
// than one means it must name one — and can say so at CONFIG time instead of discovering
// it as a refusal at RUN time. `software` lets it sanity-check what it has been pointed
// at before the first sign-in, which is what #1753's tag is for.

export interface ToolConfigAccount {
  slug: string;
  name: string;
  implicit: boolean;
}

export interface ToolConfigPortal {
  slug: string;
  name: string;
  software: string | null;
  accounts: ToolConfigAccount[];
}

// Build the wire shape from the registries. Pure: it takes the rows and picks fields,
// so the DB reader stays in lib/portals.ts and the disclosure boundary stays testable
// without a database. Portal order is the caller's (the registry's name order); accounts
// are ordered implicit-first, then by name, so `tool init` writes a stable config file
// and the omitted-account default reads first.
export function buildToolConfig(
  portals: readonly {
    id: number;
    slug: string;
    name: string;
    software: string | null;
  }[],
  accounts: readonly {
    portalId: number;
    slug: string;
    name: string;
    implicit: boolean;
  }[]
): ToolConfigPortal[] {
  const byPortal = new Map<number, ToolConfigAccount[]>();
  for (const a of accounts) {
    const list = byPortal.get(a.portalId);
    const entry = { slug: a.slug, name: a.name, implicit: a.implicit };
    if (list) list.push(entry);
    else byPortal.set(a.portalId, [entry]);
  }
  return portals.map((p) => {
    const list = (byPortal.get(p.id) ?? []).slice();
    list.sort(
      (a, b) =>
        Number(b.implicit) - Number(a.implicit) || a.name.localeCompare(b.name)
    );
    return {
      slug: p.slug,
      name: p.name,
      software: p.software,
      accounts: list,
    };
  });
}
