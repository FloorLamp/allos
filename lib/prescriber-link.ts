// Med → prescriber (individual provider) link resolution (issue #1051). PURE — no
// DB, no network. The DB seam (lib/providers-db resolveExactPrescriberId, the
// backfill migration, the data-quality builder) supplies the candidate registry rows;
// this file owns the DECISION.
//
// Semantics decision (a): intake_items.provider_id is the prescriber link — an
// INDIVIDUAL. The write-time resolver therefore matches ONLY individual-type rows,
// NEVER an organization (the picker-org-default trap: a person typed into an
// org-defaulted picker mints a mistyped org row the type-folded dedup key keeps
// permanently separate). A near-miss or an org-only match NEVER links silently — it is
// surfaced by the #1045 suggest-and-accept gap detector instead.

// A shared-registry provider row, the subset the decision needs.
export interface RegistryProviderRow {
  id: number;
  type: "individual" | "organization";
  name: string;
  npi: string | null;
}

// Collapse whitespace + lowercase for a stable comparison (mirrors
// normalizeProviderName, kept local so this module imports nothing).
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

// Credential suffixes that don't distinguish a person ("Sarah Chen, MD" ≡ "Sarah
// Chen"), stripped for surname comparison in the near-miss heuristic only — NEVER for
// the exact-link path (exactness stays strict).
const CREDENTIALS = new Set([
  "md",
  "do",
  "np",
  "pa",
  "rn",
  "phd",
  "dds",
  "dmd",
  "od",
  "pharmd",
  "msn",
  "aprn",
  "crnp",
  "facp",
]);

// The alphabetic tokens of a name with punctuation dropped and credential suffixes
// removed (["dr","sarah","chen"] → ["sarah","chen"]; a leading honorific "dr" is
// also dropped so "Dr. Chen" and "Chen" share a surname).
function surnameTokens(name: string): string[] {
  return norm(name)
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !CREDENTIALS.has(t) && t !== "dr");
}

// Write-time EXACT resolution (#1051 ask 2), entity-type-aware. Returns the id of the
// single individual-type registry row this prescriber text (or its NPI) exactly
// identifies, else null. Links ONLY on an unambiguous exact match; never to an org;
// never on ambiguity (2+ individuals share the name → null, the exclusion discipline).
export function resolveExactIndividualProvider(
  text: string | null | undefined,
  npi: string | null | undefined,
  candidates: readonly RegistryProviderRow[]
): number | null {
  const nn = digits(npi);
  if (nn) {
    const byNpi = candidates.filter(
      (c) => c.type === "individual" && digits(c.npi) === nn
    );
    if (byNpi.length === 1) return byNpi[0].id;
  }
  const t = norm(text ?? "");
  if (!t) return null;
  const byName = candidates.filter(
    (c) => c.type === "individual" && norm(c.name) === t
  );
  return byName.length === 1 ? byName[0].id : null;
}

// The classification of a med's free-text prescriber against the registry, for the
// #1045 suggest-and-accept gap detector (historical rows the exact backfill can't
// claim). Order matters — an EXACT individual match wins (it is already linked by the
// resolver/backfill, so it is never a gap).
export type PrescriberLinkClass =
  // An exact individual match exists — already linkable, not a gap.
  | { kind: "exact"; providerId: number }
  // The name matches ONLY an organization-typed row (no individual twin): the
  // picker-org-default trap. Proposes "is this a person? [Fix type & link]".
  | { kind: "org-mistype"; providerId: number; providerName: string }
  // A near-miss individual (same surname, non-exact): "3 meds say 'S. Chen' — link to
  // Sarah Chen, MD?". Proposes without linking.
  | { kind: "near-miss"; providerId: number; providerName: string }
  // Nothing to propose.
  | { kind: "none" };

// Is `text` a near-miss of an individual `name` — differing but clearly the same
// person? Conservative: NOT exact, and they share the same final surname token (the
// "S. Chen" ↔ "Sarah Chen" shape), with at least a surname on both sides.
function isNearMiss(text: string, name: string): boolean {
  if (norm(text) === norm(name)) return false;
  const a = surnameTokens(text);
  const b = surnameTokens(name);
  if (a.length === 0 || b.length === 0) return false;
  const surnameA = a[a.length - 1];
  const surnameB = b[b.length - 1];
  return surnameA.length >= 3 && surnameA === surnameB;
}

// Classify a prescriber text against the registry (#1051 historical / suggest-and-
// accept). Pure: the caller supplies the rows sharing / near this name.
export function classifyPrescriberLink(
  text: string | null | undefined,
  candidates: readonly RegistryProviderRow[]
): PrescriberLinkClass {
  const t = norm(text ?? "");
  if (!t) return { kind: "none" };

  const exactIndividual = candidates.filter(
    (c) => c.type === "individual" && norm(c.name) === t
  );
  if (exactIndividual.length === 1)
    return { kind: "exact", providerId: exactIndividual[0].id };
  // Ambiguous exact individuals (2+) fall through to near-miss handling (a
  // disambiguation ask), never an auto "exact".

  // Org-only exact match with no individual twin → the fix-type suggestion.
  const exactOrg = candidates.filter(
    (c) => c.type === "organization" && norm(c.name) === t
  );
  if (exactIndividual.length === 0 && exactOrg.length === 1)
    return {
      kind: "org-mistype",
      providerId: exactOrg[0].id,
      providerName: exactOrg[0].name,
    };

  // Near-miss to a single individual → propose the link.
  const near = candidates.filter(
    (c) => c.type === "individual" && isNearMiss(t, c.name)
  );
  if (near.length === 1)
    return {
      kind: "near-miss",
      providerId: near[0].id,
      providerName: near[0].name,
    };

  return { kind: "none" };
}
