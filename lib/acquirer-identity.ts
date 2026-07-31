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
  | { kind: "identity"; portalSlug: string; patientLabel: string };

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
  patient?: unknown;
}): UploadTargetResult {
  const hasProfile = text(input.profile).trim() !== "";
  const portal = text(input.portal).trim();
  const patient = text(input.patient);
  const hasIdentity = portal !== "" || patient.trim() !== "";

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

  // Identity form: BOTH halves are required. A portal with no patient cannot identify a
  // person on a proxy-access login, and a patient with no portal is not a key at all.
  if (!isPortalSlug(portal)) {
    return { ok: false, error: "`portal` must be a known portal id" };
  }
  if (!isPatientLabel(patient)) {
    return { ok: false, error: "`patient` must be a non-empty patient label" };
  }
  return {
    ok: true,
    target: {
      kind: "identity",
      portalSlug: portal,
      patientLabel: normalizePatientLabel(patient),
    },
  };
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

export interface SyncReportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
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
}): SyncReportCounts {
  return {
    inserted: count(input.inserted),
    updated: count(input.updated),
    unchanged: count(input.unchanged),
    failed: count(input.failed),
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
  received: number;
  error: string | null;
}

export function syncReportEvent(
  status: SyncReportStatus,
  counts: SyncReportCounts,
  message: string | null
): SyncReportEvent {
  const received =
    counts.inserted + counts.updated + counts.unchanged + counts.failed;
  return {
    ok: status !== "failed",
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
    // A document the tool could not push is `skipped` in the shared vocabulary: it was
    // handed to the run but deliberately not persisted.
    skipped: counts.failed,
    received,
    // Only a failure carries an error line, and only the tool's own message — never
    // invented here, and truncated by the DB writer.
    error: status === "failed" ? (message ?? "sync failed") : null,
  };
}
