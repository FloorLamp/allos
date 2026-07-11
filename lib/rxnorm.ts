// RxNorm normalization (issue #144): map a free-text medication/supplement name to
// an RxNorm concept (RxCUI) via NLM's public RxNav `/approximateTerm` API, so the
// interaction checker can match on a stable code instead of only on the name.
//
// THIS IS THE ONLY PART OF THE FEATURE THAT TOUCHES THE NETWORK, and the ONLY thing
// the whole feature ever sends off-box: a single drug/supplement NAME to NLM's
// public RxNav service. No PHI, no identifiers — just the term. The bundled
// interaction dataset (lib/drug-interactions.json) is fully offline; if this lookup
// is unreachable or disabled, the item simply has no RxCUI and matches by name only
// (graceful degradation, mirroring the AI layer). The user CONFIRMS the mapping on
// the item's edit form, so a wrong approximate match is never silently trusted.
//
// The fetch itself is not unit-testable (network), so the response SHAPE parsing is
// split into the pure parseApproximateTerm() below (covered by lib/__tests__).

// NLM RxNav approximateTerm endpoint. Public, key-free, no auth. Documented at
// https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.approximateTerm.html
const RXNAV_BASE = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json";

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
