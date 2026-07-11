// RxNorm normalization (issue #144): map a free-text medication/supplement name to
// an RxNorm concept (RxCUI) via NLM's public RxNav `/approximateTerm` API, so the
// interaction checker can match on a stable code instead of only on the name.
//
// THIS IS THE ONLY PART OF THE FEATURE THAT TOUCHES THE NETWORK, and the ONLY thing
// the whole feature ever sends off-box: a drug/supplement NAME (approximateTerm)
// or a confirmed RxCUI CODE (the ingredient decomposition below) to NLM's public
// RxNav service. No PHI, no identifiers — just the term/code. The bundled
// interaction dataset (lib/drug-interactions.json) is fully offline; if this lookup
// is unreachable or disabled, the item simply has no RxCUI and matches by name only
// (graceful degradation, mirroring the AI layer). The user CONFIRMS the mapping on
// the item's edit form, so a wrong approximate match is never silently trusted.
//
// INGREDIENT DECOMPOSITION (issue #279): approximateTerm resolves a product name
// to a PRODUCT-level concept (SCD/SBD) — for a combination medication ("Hyzaar",
// losartan/hydrochlorothiazide) that single code never appears in the interaction
// datasets' INGREDIENT-level `rxcuis` lists, so a combo product silently missed
// every code-keyed rule. When the user confirms a candidate, we now ALSO fetch the
// concept's active ingredients (`/rxcui/{id}/related?tty=IN`) and cache them on the
// item (intake_items.rxcui_ingredients), and both matchers try every cached CUI.
// This equally fixes a single-ingredient product-level pick (an SCD like
// "lisinopril 10 MG Oral Tablet" now matches through its one ingredient).
//
// The fetches themselves are not unit-testable (network), so the response SHAPE
// parsing is split into the pure parseApproximateTerm() /
// parseRelatedIngredients() below (covered by lib/__tests__).

// NLM RxNav approximateTerm endpoint. Public, key-free, no auth. Documented at
// https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.approximateTerm.html
const RXNAV_BASE = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json";

// NLM RxNav related-by-term-type endpoint (ingredient decomposition). Documented at
// https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getRelatedByType.html
const RXNAV_RELATED_BASE = "https://rxnav.nlm.nih.gov/REST/rxcui";

// Keep the lookup snappy and non-blocking — a slow/absent network must never hang a
// request. On timeout/error we return [] (degrade to name-only matching).
const LOOKUP_TIMEOUT_MS = 4000;

// A candidate RxNorm concept for a name, ranked by RxNav's approximate-match score.
export interface RxNormCandidate {
  rxcui: string;
  name: string;
  score: number;
}

// The subset of the approximateTerm JSON we read. RxNav returns
// { approximateGroup: { candidate: [ { rxcui, score, name?, ... } ] } }.
interface ApproximateTermResponse {
  approximateGroup?: {
    candidate?: {
      rxcui?: string;
      score?: string | number;
      rank?: string | number;
      name?: string;
    }[];
  };
}

// Pure parser for the approximateTerm response: de-duplicate candidates by RxCUI
// (RxNav can return the same concept at several ranks), keep the highest score per
// RxCUI, and return them best-score-first, capped at `limit`. Skips candidates with
// no RxCUI. Score is coerced to a number (RxNav sends it as a string).
export function parseApproximateTerm(
  json: unknown,
  limit = 5
): RxNormCandidate[] {
  const candidates =
    (json as ApproximateTermResponse)?.approximateGroup?.candidate ?? [];
  const byRxcui = new Map<string, RxNormCandidate>();
  for (const c of candidates) {
    const rxcui = c?.rxcui != null ? String(c.rxcui).trim() : "";
    if (!rxcui) continue;
    const score = Number(c?.score ?? 0) || 0;
    const name = (c?.name ?? "").trim();
    const prev = byRxcui.get(rxcui);
    if (!prev || score > prev.score) {
      byRxcui.set(rxcui, { rxcui, name, score });
    }
  }
  return [...byRxcui.values()]
    .sort((a, b) => b.score - a.score || a.rxcui.localeCompare(b.rxcui))
    .slice(0, limit);
}

// ---- Ingredient decomposition (issue #279) --------------------------------

// A stored RxCUI is a short numeric string. The `rxcui_ingredients` column (and the
// hidden form field that feeds it) carries UNTRUSTED text, so everything is parsed
// through this shape check; anything else is dropped.
const RXCUI_SHAPE = /^\d{1,10}$/;

// Defensive cap — no real product has anywhere near this many active ingredients.
const MAX_INGREDIENT_CUIS = 25;

// The subset of the `/rxcui/{id}/related?tty=IN` JSON we read. RxNav returns
// { relatedGroup: { conceptGroup: [ { tty, conceptProperties: [ { rxcui, … } ] } ] } }.
interface RelatedByTypeResponse {
  relatedGroup?: {
    conceptGroup?: {
      tty?: string;
      conceptProperties?: { rxcui?: string }[] | null;
    }[];
  };
}

// Pure parser for the related-by-type response: collect the RxCUIs of every
// ingredient (tty "IN") concept, de-duplicated, shape-checked, sorted for a stable
// order, capped. Returns [] for a malformed body or a concept with no ingredients.
export function parseRelatedIngredients(json: unknown): string[] {
  const groups =
    (json as RelatedByTypeResponse)?.relatedGroup?.conceptGroup ?? [];
  const cuis = new Set<string>();
  for (const g of groups) {
    if (g?.tty !== "IN") continue;
    for (const p of g?.conceptProperties ?? []) {
      const rxcui = p?.rxcui != null ? String(p.rxcui).trim() : "";
      if (RXCUI_SHAPE.test(rxcui)) cuis.add(rxcui);
    }
  }
  return [...cuis].sort().slice(0, MAX_INGREDIENT_CUIS);
}

// Codec for the intake_items.rxcui_ingredients column (a JSON array of RxCUI
// strings, NULL when unresolved/empty). parse accepts untrusted input — the DB
// column or the item form's hidden field — and drops anything that isn't a
// plausible RxCUI, so a forged payload degrades to fewer codes, never to garbage
// in the matcher. serialize is its inverse (null for an empty list) so the column
// never stores "[]" noise.
export function parseRxcuiIngredients(
  raw: string | null | undefined
): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cuis = new Set<string>();
  for (const v of parsed) {
    const rxcui =
      typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
    if (RXCUI_SHAPE.test(rxcui)) cuis.add(rxcui);
  }
  return [...cuis].sort().slice(0, MAX_INGREDIENT_CUIS);
}

export function serializeRxcuiIngredients(cuis: string[]): string | null {
  const clean = parseRxcuiIngredients(JSON.stringify(cuis));
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

// Resolve a confirmed RxCUI to its active-ingredient RxCUIs. Server-side only
// (called from a Server Action when the user confirms a candidate). Sends ONLY the
// code — no name, no PHI. Returns [] on a malformed rxcui, timeout, non-OK
// response, or any parse/network error — the item then matches by its product
// RxCUI + name only (graceful degradation, same contract as the candidate lookup).
export async function lookupRxNormIngredients(
  rxcui: string
): Promise<string[]> {
  const code = rxcui.trim();
  if (!RXCUI_SHAPE.test(code)) return [];
  const url = `${RXNAV_RELATED_BASE}/${encodeURIComponent(code)}/related.json?tty=IN`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return parseRelatedIngredients(json);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Look up RxNorm candidates for a free-text drug/supplement name. Server-side only
// (called from a Server Action). Returns [] on empty input, timeout, non-OK
// response, or any parse/network error — the caller then keeps name-only matching.
export async function lookupRxNormCandidates(
  name: string,
  limit = 5
): Promise<RxNormCandidate[]> {
  const term = name.trim();
  if (!term) return [];
  const url = `${RXNAV_BASE}?term=${encodeURIComponent(term)}&maxEntries=${limit}&option=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return parseApproximateTerm(json, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
