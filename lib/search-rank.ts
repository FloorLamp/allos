// Pure ranking/merging for the global (Cmd-K) search (issue #133). The DB
// fan-out in lib/queries/search.ts decides *what* matches (profile-scoped LIKE
// queries per domain); this module decides *ordering*: it scores each hit's
// match quality (exact > prefix > substring), breaks ties by recency, and groups
// the flat hit list into the fixed domain order the palette renders. Kept free of
// DB/React so it can be unit-tested (lib/__tests__/search-rank.test.ts).

export type SearchDomain =
  | "biomarker"
  | "document"
  | "activity"
  | "supplement"
  | "immunization"
  | "goal"
  | "page";

export interface SearchHit {
  domain: SearchDomain;
  // Stable, domain-unique key — React key and dedup identity.
  key: string;
  // Primary text the hit is matched/ranked against and shown as the result's
  // main line.
  title: string;
  // Secondary line (value/date/type/status); not used for ranking.
  subtitle: string | null;
  href: string;
  // ISO date (YYYY-MM-DD) for the recency tiebreak; null for undated hits
  // (supplements, goals, pages), which sort after dated ones at the same tier.
  date: string | null;
}

export interface SearchGroup {
  domain: SearchDomain;
  label: string;
  hits: SearchHit[];
}

// The order result groups appear in the palette (mirrors the issue's list).
export const SEARCH_DOMAIN_ORDER: SearchDomain[] = [
  "biomarker",
  "document",
  "activity",
  "supplement",
  "immunization",
  "goal",
  "page",
];

export const SEARCH_DOMAIN_LABELS: Record<SearchDomain, string> = {
  biomarker: "Biomarkers",
  document: "Documents",
  activity: "Activities",
  supplement: "Supplements",
  immunization: "Immunizations",
  goal: "Goals",
  page: "Pages",
};

// How closely `query` matches `text`: 3 exact, 2 prefix, 1 substring, 0 none.
// Case- and edge-whitespace-insensitive.
export function matchTier(text: string, query: string): number {
  const t = text.trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (q === "" || t === "") return 0;
  if (t === q) return 3;
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

// Order hits within one domain: match quality desc, then recency (later date
// first, undated last), then title/key for a stable, deterministic order.
export function sortHits(hits: SearchHit[], query: string): SearchHit[] {
  return [...hits].sort((a, b) => {
    const ta = matchTier(a.title, query);
    const tb = matchTier(b.title, query);
    if (ta !== tb) return tb - ta;
    // Recency: compare ISO date strings lexically; "" (undated) sorts last.
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
}

// Merge a flat hit list into grouped, ranked results: each domain sorted and
// capped, emitted in SEARCH_DOMAIN_ORDER, dropping empty groups.
export function rankAndGroup(
  hits: SearchHit[],
  query: string,
  perDomainCap = 5
): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const domain of SEARCH_DOMAIN_ORDER) {
    const domainHits = sortHits(
      hits.filter((h) => h.domain === domain),
      query
    ).slice(0, perDomainCap);
    if (domainHits.length > 0) {
      groups.push({
        domain,
        label: SEARCH_DOMAIN_LABELS[domain],
        hits: domainHits,
      });
    }
  }
  return groups;
}

// Flatten grouped results into the top-to-bottom order the arrow keys walk.
export function flattenHits(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => g.hits);
}
